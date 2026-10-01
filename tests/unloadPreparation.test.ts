import { afterEach, describe, expect, it, vi } from 'vitest'
import { register } from '../src/index'
import { getStore, disposeStore } from '../src/store'
import type { SessionSnapshot } from '../src/contracts/execution'
import { sessionBackendFixture } from './sessionBackendFixture'
import en from '../locales/en.json'
import { assistantConfigurationReady, createAssistantApi, disposeAssistantConfiguration } from '../src/api'

const fixtures: ReturnType<typeof sessionBackendFixture>[] = []
const disposers: Array<() => Promise<void>> = []
function fixture() { const backend = sessionBackendFixture(); fixtures.push(backend); return backend }
const until = async (condition: () => boolean) => vi.waitFor(() => expect(condition()).toBe(true))
async function start(backend: ReturnType<typeof sessionBackendFixture>) {
  const dispose = register(backend.api); disposers.push(dispose)
  const store = getStore(backend.api); await store.whenReady
  return { store, dispose }
}
afterEach(async () => {
  for (const backend of fixtures.splice(0)) { await backend.cleanup(); await disposeStore(backend.api) }
  for (const dispose of disposers.splice(0)) await dispose()
})

describe('renderer and backend unload ownership', () => {
  function configurationFixture() {
    const backend = fixture(), host = { ...backend.api }, listeners = new Set<() => void>()
    Reflect.deleteProperty(host, 'assistant'); Reflect.deleteProperty(host, 'channels')
    const read = vi.fn(async () => ({ revision: 0, values: {} }))
    const originalCall = host.backend.call, originalOn = host.backend.on
    host.backend = { ...host.backend,
      call: (async (method: string, input: unknown) => {
        if (method === 'configuration.settings') return read()
        if (method === 'ai.getConfig') return (await backend.api.assistant.getConfig()).data
        if (method === 'ai.listChats') return (await backend.api.assistant.listChats()).data
        if (method === 'ai.listPending') return (await backend.api.assistant.listPending()).data
        if (method === 'channels.list') return (await backend.api.channels.list()).data
        return originalCall(method, input)
      }) as typeof host.backend.call,
      on: ((name, listener) => {
        if (name !== 'configuration.changed') return originalOn(name, listener)
        const changed = () => listener({})
        listeners.add(changed)
        return () => { listeners.delete(changed) }
      }) as typeof host.backend.on
    }
    return { backend, read, create: () => createAssistantApi(host), changed: () => listeners.forEach(listener => listener()) }
  }

  it('recovers the failed initial configuration snapshot without repeating later initialization effects', async () => {
    const test = configurationFixture()
    test.read.mockRejectedValueOnce(new Error('Plugin UI request timed out'))
    const api = test.create(), store = getStore(api)
    try {
      await expect(store.whenReady).rejects.toThrow('Plugin UI request timed out')
      expect(store.getSnapshot()).toMatchObject({ ready: false, config: null, error: 'Plugin UI request timed out' })
      await until(() => store.getSnapshot().ready)
      await expect(assistantConfigurationReady(api)).resolves.toBeUndefined()
      expect(test.read).toHaveBeenCalledTimes(2)
      expect(store.getSnapshot().error).toBeNull()
      const id = store.getSnapshot().active?.id
      test.changed(); test.changed()
      await until(() => test.read.mock.calls.length === 3)
      expect(store.getSnapshot().active?.id).toBe(id)
      await expect(store.prepareUnload()).resolves.toBeUndefined()
    } finally { await disposeStore(api); disposeAssistantConfiguration(api) }
  })

  it('settles a failed initial read at unload without replaying reads or abandoning an accepted save', async () => {
    const test = configurationFixture(), gate = test.backend.gate()
    test.read.mockRejectedValue(new Error('Plugin UI request timed out'))
    const api = test.create(), store = getStore(api)
    try {
      await expect(store.whenReady).rejects.toThrow('Plugin UI request timed out')
      const save = vi.spyOn(api.assistant, 'saveChat').mockImplementation(async () => { await gate.promise; return { ok: true } })
      store.newChat()
      const thread = { ...store.getSnapshot().active!, messages: [{ role: 'user' as const, content: 'Retain this edit' }] }
      const saving = store.saveThread(thread)
      let prepared = false
      const preparation = store.prepareUnload().then(() => { prepared = true })
      await Promise.resolve()
      expect(prepared).toBe(false)
      gate.resolve(); await saving; await preparation
      expect(save).toHaveBeenCalledTimes(1)
      expect(test.read).toHaveBeenCalledTimes(1)
      expect(store.getSnapshot()).toMatchObject({ ready: false, error: 'Plugin UI request timed out' })
    } finally { await disposeStore(api); disposeAssistantConfiguration(api) }
  })

  it('still refuses unload for a genuine failed save after the initial configuration read failed', async () => {
    const test = configurationFixture()
    test.read.mockRejectedValue(new Error('Plugin UI request timed out'))
    const api = test.create(), store = getStore(api)
    try {
      await expect(store.whenReady).rejects.toThrow('Plugin UI request timed out')
      const save = vi.spyOn(api.assistant, 'saveChat').mockResolvedValue({ ok: false, error: 'Disk unavailable' })
      store.newChat()
      const thread = { ...store.getSnapshot().active!, messages: [{ role: 'user' as const, content: 'Keep this edit' }] }
      await expect(store.saveThread(thread)).rejects.toThrow('Disk unavailable')
      await expect(store.prepareUnload()).rejects.toThrow('Disk unavailable')
      expect(store.retainedThread(thread.id)?.messages).toEqual(thread.messages)
      expect(save).toHaveBeenCalledTimes(2)
    } finally { await disposeStore(api); disposeAssistantConfiguration(api) }
  })

  it('bounds automatic configuration retries and resumes once an authoritative refresh succeeds', async () => {
    vi.useFakeTimers()
    const test = configurationFixture()
    test.read.mockRejectedValue(new Error('Plugin UI request timed out'))
    const api = test.create(), store = getStore(api)
    try {
      await expect(store.whenReady).rejects.toThrow('Plugin UI request timed out')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(test.read).toHaveBeenCalledTimes(4)
      expect(store.getSnapshot().ready).toBe(false)
      test.read.mockResolvedValue({ revision: 2, values: {} })
      test.changed(); test.changed()
      await vi.advanceTimersByTimeAsync(0)
      await store.whenReady
      expect(test.read).toHaveBeenCalledTimes(5)
      expect(store.getSnapshot()).toMatchObject({ ready: true, error: null })
    } finally { await disposeStore(api); disposeAssistantConfiguration(api); vi.useRealTimers() }
  })

  it.each(['dispose', 'prepareUnload'] as const)('cancels scheduled configuration recovery on %s', async transition => {
    vi.useFakeTimers()
    const test = configurationFixture()
    test.read.mockRejectedValueOnce(new Error('Plugin UI request timed out'))
    const api = test.create(), store = getStore(api)
    try {
      await expect(store.whenReady).rejects.toThrow('Plugin UI request timed out')
      await store[transition]()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(test.read).toHaveBeenCalledTimes(1)
      expect(store.getSnapshot().ready).toBe(false)
    } finally { await disposeStore(api); disposeAssistantConfiguration(api); vi.useRealTimers() }
  })

  it('does not activate a disposed owner when its initial configuration read finishes late', async () => {
    const test = configurationFixture(), gate = test.backend.gate()
    test.read.mockImplementation(async () => { await gate.promise; return { revision: 0, values: {} } })
    const api = test.create(), store = getStore(api), guard = vi.spyOn(api.guard, 'registerRuntime'), channels = vi.spyOn(api.channels, 'list')
    const disposal = store.dispose()
    gate.resolve(); await disposal
    expect(store.getSnapshot().ready).toBe(false)
    expect(guard).not.toHaveBeenCalled()
    expect(channels).not.toHaveBeenCalled()
    disposeAssistantConfiguration(api)
  })

  it('defers late initialization effects while preparing and resumes them only after cancellation', async () => {
    const test = configurationFixture(), gate = test.backend.gate()
    test.read.mockImplementation(async () => { await gate.promise; return { revision: 0, values: {} } })
    const api = test.create(), store = getStore(api), guard = vi.spyOn(api.guard, 'registerRuntime'), channels = vi.spyOn(api.channels, 'list')
    try {
      const preparing = store.prepareUnload()
      gate.resolve(); await preparing
      expect(store.getSnapshot().ready).toBe(false)
      expect(guard).not.toHaveBeenCalled()
      expect(channels).not.toHaveBeenCalled()
      store.resumeAfterUnloadCancellation()
      await store.whenReady
      expect(store.getSnapshot().ready).toBe(true)
      expect(guard).toHaveBeenCalledTimes(1)
      expect(channels).toHaveBeenCalledTimes(1)
      expect(test.read).toHaveBeenCalledTimes(1)
    } finally { await disposeStore(api); disposeAssistantConfiguration(api) }
  })

  it('preserves a newer chat selection and save error when configuration recovers', async () => {
    const test = configurationFixture()
    test.read.mockRejectedValueOnce(new Error('Plugin UI request timed out'))
    const api = test.create(), store = getStore(api)
    try {
      await expect(store.whenReady).rejects.toThrow('Plugin UI request timed out')
      vi.spyOn(api.assistant, 'saveChat').mockResolvedValue({ ok: false, error: 'Disk unavailable' })
      store.newChat()
      const thread = { ...store.getSnapshot().active!, messages: [{ role: 'user' as const, content: 'Keep this selection' }] }
      await expect(store.saveThread(thread)).rejects.toThrow('Disk unavailable')
      await until(() => store.getSnapshot().ready)
      expect(store.getSnapshot()).toMatchObject({ ready: true, error: 'Disk unavailable', active: { id: thread.id } })
      expect(store.retainedThread(thread.id)?.messages).toEqual(thread.messages)
    } finally { await disposeStore(api); disposeAssistantConfiguration(api) }
  })

  it('prepares the renderer without cancelling backend work and accepts backend messages while it is detached', async () => {
    const backend = fixture(), finish = backend.gate()
    backend.model.mockImplementationOnce(async (_session, _turn, controls) => { await finish.promise; await controls.message({ role: 'assistant', content: 'Moss identified' }) })
    const { store } = await start(backend)
    await store.send('Inspect moss'); await until(() => backend.model.mock.calls.length === 1)
    const id = store.getSnapshot().active!.id
    await backend.runBeforeUnload()
    expect(backend.model.mock.calls[0][2].signal.aborted).toBe(false)
    expect(backend.call.mock.calls.some(([method]) => method === 'session.stop')).toBe(false)
    await store.send('Blocked during renderer transition')
    expect(backend.coordinator.snapshot(id)?.queue).toEqual([])
    await backend.coordinator.enqueue({ id: 'backend-inbound', conversationId: id, text: 'Inspect fern' })
    finish.resolve(); await until(() => backend.coordinator.snapshot(id)?.state === 'IDLE')
    expect(backend.chatThreads.get(id)?.messages.map(message => message.content)).toEqual(['Inspect moss', 'Moss identified', 'Inspect fern'])
    backend.runUnloadCancellation()
    await store.send('Inspect oak'); await until(() => backend.model.mock.calls.length === 3)
    expect(getStore(backend.api)).toBe(store)
  })

  it('detaches repeated renderer disposal and reopens persisted work without another inference', async () => {
    const backend = fixture(), finish = backend.gate()
    backend.model.mockImplementation(async (_session, _turn, controls) => { await finish.promise; await controls.message({ id: 'moss-answer', role: 'assistant', content: 'Saved answer' }) })
    const { store, dispose } = await start(backend)
    await store.send('Inspect moss'); await until(() => backend.model.mock.calls.length === 1)
    const id = store.getSnapshot().active!.id, signal = backend.model.mock.calls[0][2].signal
    const disposal = dispose()
    expect(dispose()).toBe(disposal)
    await disposal
    expect(backend.listenerCount).toBe(0)
    expect(signal.aborted).toBe(false)
    finish.resolve(); await until(() => backend.coordinator.snapshot(id)?.state === 'IDLE')
    const reopened = (await start(backend)).store
    expect(reopened).not.toBe(store)
    expect(reopened.getSnapshot().active).toMatchObject({ id, messages: [{ content: 'Inspect moss' }, { id: 'moss-answer', content: 'Saved answer' }] })
    expect(backend.model).toHaveBeenCalledTimes(1)
  })

  it('keeps an active backend approval waiting when the renderer closes and aborts it only at backend shutdown', async () => {
    const backend = fixture()
    backend.model.mockImplementation(async (_session, _turn, controls) => {
      await controls.state('AWAITING_TOOLS'); await controls.state('AWAITING_APPROVAL')
      await new Promise<void>(resolve => { if (controls.signal.aborted) resolve(); else controls.signal.addEventListener('abort', () => resolve(), { once: true }) })
    })
    const { store, dispose } = await start(backend)
    await store.send('Write moss note')
    const id = store.getSnapshot().active!.id
    await until(() => backend.coordinator.snapshot(id)?.state === 'AWAITING_APPROVAL')
    await backend.runBeforeUnload(); await dispose()
    expect(backend.coordinator.snapshot(id)?.state).toBe('AWAITING_APPROVAL')
    expect(backend.model.mock.calls[0][2].signal.aborted).toBe(false)
    await backend.coordinator.close()
    expect(backend.coordinator.snapshot(id)).toMatchObject({ state: 'INTERRUPTED', paused: true })
    expect(backend.chatThreads.get(id)?.messages.filter(message => message.role === 'tool')).toEqual([])
  })

  it('waits for aborted inference and final chat projection before completing backend shutdown', async () => {
    const backend = fixture(), finish = backend.gate(), projection = backend.gate()
    backend.model.mockImplementation(async (_session, _turn, controls) => { await controls.stream('Partial moss answer'); await finish.promise })
    backend.project.mockImplementation(async session => { await projection.promise; await backend.persist(session) })
    const { store } = await start(backend)
    await store.send('Inspect moss')
    const id = store.getSnapshot().active!.id
    await until(() => backend.coordinator.snapshot(id)?.streamingText === 'Partial moss answer')
    let closed = false
    const closing = backend.coordinator.close().then(() => { closed = true })
    await until(() => backend.model.mock.calls[0][2].signal.aborted)
    await expect(backend.coordinator.enqueue({ id: 'too-late', conversationId: id, text: 'Inspect fern' })).rejects.toThrow('Assistant is stopping')
    expect(closed).toBe(false)
    finish.resolve(); await until(() => backend.project.mock.calls.length === 1)
    expect(closed).toBe(false)
    projection.resolve(); await closing
    expect(backend.chatThreads.get(id)?.messages.at(-1)).toMatchObject({ content: 'Partial moss answer', error: true })
    const durable = await backend.repository.get<SessionSnapshot>('sessions', id)
    expect(durable).toMatchObject({ state: 'INTERRUPTED', paused: true })
    expect(durable?.thread?.messages).toEqual(backend.chatThreads.get(id)?.messages)
  })

  it('drains an in-flight journal commit at shutdown before restoring without replay', async () => {
    const backend = fixture(), finish = backend.gate(), journal = backend.gate()
    const original = backend.data.transaction
    let committing = false
    vi.spyOn(backend.data, 'transaction').mockImplementation(async operations => {
      if (operations.some(operation => operation.dataset === 'session_events' && !Array.isArray(operation.values) && operation.values?.state === 'message' && (operation.values.payload as { payload?: { id?: string } })?.payload?.id === 'answer')) { committing = true; await journal.promise }
      return original(operations)
    })
    backend.model.mockImplementation(async (_session, _turn, controls) => { await finish.promise; await controls.message({ id: 'answer', role: 'assistant', content: 'Moss result' }) })
    const { store } = await start(backend)
    await store.send('Inspect moss'); await until(() => backend.model.mock.calls.length === 1)
    const id = store.getSnapshot().active!.id
    finish.resolve(); await until(() => committing)
    let closed = false
    const closing = backend.coordinator.close().then(() => { closed = true })
    expect(closed).toBe(false)
    expect((await backend.repository.get<SessionSnapshot>('sessions', id))?.thread?.messages.some(message => message.id === 'answer')).toBe(false)
    journal.resolve(); await closing
    await backend.restore()
    expect(backend.coordinator.snapshot(id)?.thread?.messages.filter(message => message.id === 'answer')).toHaveLength(1)
    expect(backend.model).toHaveBeenCalledTimes(1)
  })

  it('recovers a failed transcript projection from the committed journal without re-inference', async () => {
    const backend = fixture()
    backend.model.mockImplementation(async (_session, _turn, controls) => { await controls.message({ id: 'durable-answer', role: 'assistant', content: 'Retained moss answer' }) })
    backend.project.mockRejectedValueOnce(new Error('Transcript storage unavailable'))
    const { store, dispose } = await start(backend)
    await store.send('Inspect moss')
    const id = store.getSnapshot().active!.id
    await until(() => backend.project.mock.calls.length === 1)
    expect(backend.chatThreads.get(id)?.messages).toEqual([])
    expect((await backend.repository.get<SessionSnapshot>('sessions', id))?.thread?.messages.at(-1)?.id).toBe('durable-answer')
    await dispose(); await backend.coordinator.close(); await backend.restore()
    const reopened = (await start(backend)).store
    expect(reopened.getSnapshot().active?.messages.at(-1)?.content).toBe('Retained moss answer')
    expect(backend.model).toHaveBeenCalledTimes(1)
  })

  it.each(['clear-chat', 'delete-chat'] as const)('does not resurrect journalled work after explicit %s and restart', async operation => {
    const backend = fixture()
    backend.model.mockImplementation(async (_session, _turn, controls) => { await controls.message({ role: 'assistant', content: 'Discarded moss answer' }) })
    const { store, dispose } = await start(backend)
    await store.send('Discard this conversation')
    const id = store.getSnapshot().active!.id
    await until(() => backend.coordinator.snapshot(id)?.state === 'IDLE')
    expect(await backend.api.commands.executeOwn(operation, { id })).toMatchObject({ ok: true })
    await backend.runBeforeUnload(); await dispose(); await backend.coordinator.close(); await backend.restore()
    expect(backend.coordinator.snapshot(id)).toBeNull()
    expect(backend.chatThreads.has(id)).toBe(false)
    expect(await backend.repository.get('conversation_deletions', id)).toMatchObject({ id })
    expect(backend.model).toHaveBeenCalledTimes(1)
  })

  it('keeps a replacement renderer isolated while the previous backend finishes', async () => {
    const backend = fixture(), finish = backend.gate()
    backend.model.mockImplementation(async (_session, _turn, controls) => { await finish.promise; await controls.message({ role: 'assistant', content: 'Old moss answer' }) })
    const first = await start(backend)
    await first.store.send('Inspect moss'); await until(() => backend.model.mock.calls.length === 1)
    const id = first.store.getSnapshot().active!.id
    await first.dispose()
    const replacement = fixture(), next = await start(replacement)
    const nextId = next.store.getSnapshot().active!.id
    finish.resolve(); await until(() => backend.coordinator.snapshot(id)?.state === 'IDLE')
    await first.dispose()
    expect(getStore(replacement.api)).toBe(next.store)
    expect(next.store.getSnapshot().active).toMatchObject({ id: nextId, messages: [] })
    expect(next.store.getSnapshot().ready).toBe(true)
    expect(backend.chatThreads.get(id)?.messages.at(-1)?.content).toBe('Old moss answer')
  })

  it('does not install a renderer guard when legacy recovered approvals cannot be cleared', async () => {
    const backend = fixture()
    await backend.api.assistant.addPending({ requestId: 'old', channelId: 'telegram', chatRef: 'forest', chatId: 'tg-telegram-forest', actionLabel: 'write', createdAt: 0, expiresAt: Date.now() + 1000 })
    const original = backend.api.assistant.removePending
    const clearing = vi.spyOn(backend.api.assistant, 'removePending').mockResolvedValue({ ok: false, error: 'Disk unavailable' })
    const guard = vi.spyOn(backend.api.guard, 'registerRuntime')
    const dispose = register(backend.api); disposers.push(dispose)
    const store = getStore(backend.api)
    await expect(store.whenReady).rejects.toThrow(en['assistant.guard.persistenceFailed'])
    await expect(store.prepareUnload()).rejects.toThrow(en['assistant.guard.persistenceFailed'])
    expect(guard).not.toHaveBeenCalled()
    expect(store.getSnapshot().ready).toBe(false)
    expect(backend.pendingApprovals.size).toBe(1)
    clearing.mockImplementation(original)
    await dispose()
    expect(backend.pendingApprovals.size).toBe(0)
  })
})
