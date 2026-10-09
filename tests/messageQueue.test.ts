import { afterEach, describe, expect, it, vi } from 'vitest'
import { getStore, disposeStore } from '../src/store'
import { updateConversation } from '../src/commands'
import { sessionBackendFixture } from './sessionBackendFixture'

const fixtures: ReturnType<typeof sessionBackendFixture>[] = []
function fixture() { const backend = sessionBackendFixture(); fixtures.push(backend); return backend }
const until = async (condition: () => boolean) => vi.waitFor(() => expect(condition()).toBe(true))
afterEach(async () => { for (const backend of fixtures.splice(0)) { await backend.cleanup(); await disposeStore(backend.api) }; vi.useRealTimers() })

describe('durable backend message queue projections', () => {
  it.each(['timeout', 'stop'])('ends stalled preparation on %s and never sends the late instruction', async end => {
    const backend = fixture(), store = getStore(backend.api), ready = backend.gate()
    await store.whenReady
    vi.useFakeTimers()
    store.whenReady = ready.promise
    const send = vi.spyOn(backend.api.backend, 'callOperation')
    const pending = store.send('Create fern.md\nFern and moss')
    expect(store.getSnapshot().activeBusy).toBe(true)
    if (end === 'stop') store.stop()
    else await vi.advanceTimersByTimeAsync(10000)
    await pending
    expect(store.getSnapshot().activeBusy).toBe(false)
    expect(store.getSnapshot().error).toContain(end === 'stop' ? 'admission cancelled' : '10 seconds')
    ready.resolve(); await vi.advanceTimersByTimeAsync(0)
    expect(send).not.toHaveBeenCalled()
    expect(backend.model).not.toHaveBeenCalled()
    await store.send('Read fern.md')
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0][0]).toBe('session.submit')
  })
  it('scopes submission failures to their originating chat and clears them on fresh input', async () => {
    const backend = fixture(), store = getStore(backend.api), gate = backend.gate()
    await store.whenReady
    const original = backend.api.backend.callOperation
    backend.api.backend.callOperation = (async (method: string, input: unknown) => {
      if (method === 'session.submit' && (input as { text?: string }).text === 'Read the first note') { await gate.promise; throw new Error('First submission failed') }
      return original(method, input)
    }) as typeof original
    const first = store.getSnapshot().active!.id
    const pending = store.send('Read the first note')
    store.newChat(); const second = store.getSnapshot().active!.id
    gate.resolve(); await pending
    expect(store.getSnapshot()).toMatchObject({ active: { id: second }, error: null })
    await store.openChat(first)
    expect(store.getSnapshot().error).toBe('First submission failed')
    await store.send('Read a fresh note')
    await until(() => backend.coordinator.snapshot(first)?.state === 'IDLE')
    expect(store.getSnapshot().error).toBeNull()
  })
  it('keeps a failed background chat error out of the selected running chat', async () => {
    const backend = fixture(), store = getStore(backend.api), failure = backend.gate(), success = backend.gate()
    backend.model.mockImplementation(async (_session, turn) => {
      if (turn?.text === 'Describe moss') { await failure.promise; throw new Error('Moss provider unavailable') }
      await success.promise
    })
    await store.whenReady
    await store.send('Describe moss'); const first = store.getSnapshot().active!.id
    store.newChat()
    await store.send('Describe ferns'); const second = store.getSnapshot().active!.id
    await until(() => backend.model.mock.calls.length === 2)
    failure.resolve()
    await until(() => backend.coordinator.snapshot(first)?.state === 'FAILED')
    expect(store.getSnapshot()).toMatchObject({ active: { id: second }, activeBusy: true, error: null })
    await store.openChat(first)
    expect(store.getSnapshot().error).toContain('Moss provider unavailable')
    await store.openChat(second)
    expect(store.getSnapshot().error).toBeNull()
    success.resolve()
    await until(() => !store.getSnapshot().busy)
  })

  it('keeps both running chats visible and streams the selected chat after switching', async () => {
    const backend = fixture(), store = getStore(backend.api), gate = backend.gate()
    backend.model.mockImplementation(async (session, _turn, controls) => { await controls.stream(`Writing ${session.conversationId}`); await gate.promise })
    await store.whenReady
    await store.send('Describe moss'); const first = store.getSnapshot().active!.id
    store.newChat()
    await store.send('Describe ferns'); const second = store.getSnapshot().active!.id
    await until(() => backend.model.mock.calls.length === 2)
    await store.reloadThreads()
    expect(store.getSnapshot().busyChatIds).toEqual(expect.arrayContaining([first, second]))
    expect(store.getSnapshot().runningChatCount).toBe(2)
    expect(store.getSnapshot().threads.map(thread => thread.id)).toEqual(expect.arrayContaining([first, second]))
    await store.openChat(first)
    expect(store.getSnapshot()).toMatchObject({ active: { id: first }, activeBusy: true, sessionState: 'INFERRING', streamingText: `Writing ${first}` })
    await store.openChat(second)
    expect(store.getSnapshot()).toMatchObject({ active: { id: second }, activeBusy: true, streamingText: `Writing ${second}` })
    expect(backend.model.mock.calls.every(([, , controls]) => !controls.signal.aborted)).toBe(true)
    gate.resolve()
    await until(() => !store.getSnapshot().busy)
    expect(store.getSnapshot().runningChatCount).toBe(0)
  })

  it('sends the current reviewed revision and instruction identity to approval without starting a renderer run', async () => {
    const backend = fixture(), store = getStore(backend.api)
    await store.whenReady
    await store.startPlanning()
    backend.model.mockImplementation(async (_session, _turn, controls) => {
      await controls.update(thread => { thread.plan = { id: 'plan-moss', revision: 2, artifactHash: 'a'.repeat(64), instructionSnapshotId: 'b'.repeat(64), directory: '.valley/plugins/data/assistant/plans/moss', status: 'review', text: 'Inspect moss' } })
    })
    await store.send('Inspect moss')
    await until(() => backend.coordinator.snapshot(store.getSnapshot().active!.id)?.state === 'AWAITING_QUESTION')
    const thread = store.getSnapshot().active!
    expect(thread.mode).toBe('plan')
    await store.implementPlan('obsolete-proposal')
    expect(backend.approval).not.toHaveBeenCalled()
    await store.implementPlan(thread.plan!.id)
    expect(backend.approval).toHaveBeenCalledWith({ conversationId: thread.id, planId: 'plan-moss', revision: 2, artifactHash: 'a'.repeat(64), instructionSnapshotId: 'b'.repeat(64) })
    expect(backend.model).toHaveBeenCalledTimes(1)
    await store.changePlan(thread.plan!.id)
    expect(store.getSnapshot().active).toMatchObject({ mode: 'plan', plan: { revision: 2, status: 'changes' } })
  })

  it('preserves prepared attachment diagnostics separately from the visible prompt and title', async () => {
    const backend = fixture(), store = getStore(backend.api)
    backend.model.mockImplementation(async (_session, _turn, controls) => {
      await controls.update(thread => { const message = thread.messages[0]; message.content = 'Attachment extraction unavailable: Parser unavailable\n\nDescribe moss'; message.attachmentFiles![0].warning = true })
    })
    await store.whenReady
    await store.send('Describe moss', [{ id: 'moss-upload', path: 'attachments/moss.png', fileName: 'moss.png', kind: 'image' }])
    const id = store.getSnapshot().active!.id
    await until(() => backend.coordinator.snapshot(id)?.state === 'IDLE')
    await store.openChat(id)
    const chat = store.getSnapshot().active!
    expect(chat.title).toBe('Describe moss')
    expect(chat.messages[0]).toMatchObject({ displayContent: 'Describe moss', attachmentIds: ['moss-upload'], attachmentFiles: [{ fileName: 'moss.png', path: 'attachments/moss.png', warning: true }] })
    expect(chat.messages[0].content).toContain('Parser unavailable')
    expect(await backend.data.dataset('attachment_refs').count({ attachmentId: 'moss-upload', chatId: id })).toBe(1)
  })

  it('queues, edits and removes messages without overlap or changing the selected draft', async () => {
    const backend = fixture(), gate = backend.gate(), seen: string[] = []
    let active = 0, maximum = 0
    backend.model.mockImplementation(async (_session, turn, controls) => {
      active++; maximum = Math.max(maximum, active); seen.push(turn!.text)
      if (seen.length === 1) await gate.promise
      await controls.message({ role: 'assistant', content: 'Ready' }); active--
    })
    const store = getStore(backend.api); await store.whenReady
    await store.send('Describe moss'); await until(() => seen.length === 1)
    const id = store.getSnapshot().active!.id
    await store.send('Describe fern'); await store.send('Remove this')
    const pending = store.getSnapshot().active!.pendingMessages!
    await store.editQueued(pending[0].id, 'Compare moss and fern'); await store.removeQueued(pending[1].id)
    store.newChat(); const draftId = store.getSnapshot().active!.id
    gate.resolve(); await until(() => backend.coordinator.snapshot(id)?.state === 'IDLE')
    expect(seen).toEqual(['Describe moss', 'Compare moss and fern']); expect(maximum).toBe(1)
    expect(store.getSnapshot().active?.id).toBe(draftId)
    await store.openChat(id)
    expect(store.getSnapshot().active?.pendingMessages).toEqual([])
    expect((await backend.data.dataset('turn_queue').get({ id: pending[1].id }))?.state).toBe('REMOVED')
  })

  it('holds a durably marked queued editor across completion until editing finishes', async () => {
    const backend = fixture(), gate = backend.gate(), seen: string[] = []
    backend.model.mockImplementation(async (_session, turn) => { seen.push(turn!.text); if (seen.length === 1) await gate.promise })
    const store = getStore(backend.api); await store.whenReady
    await store.send('Inspect moss'); await until(() => seen.length === 1)
    await store.send('Inspect fern')
    const conversationId = store.getSnapshot().active!.id, id = store.getSnapshot().active!.pendingMessages![0].id
    store.setQueueEditing(id, true)
    await until(() => backend.coordinator.snapshot(conversationId)?.queue[0]?.editing === true)
    gate.resolve(); await until(() => backend.project.mock.calls.length === 1)
    expect(seen).toEqual(['Inspect moss'])
    await store.editQueued(id, 'Compare moss and fern'); store.setQueueEditing(id, false)
    await until(() => backend.coordinator.snapshot(conversationId)?.state === 'IDLE')
    expect(seen).toEqual(['Inspect moss', 'Compare moss and fern'])
  })

  it('retains the queue on Stop and continues the interrupted turn only after ownership is released', async () => {
    const backend = fixture(), gate = backend.gate(), seen: string[] = []
    backend.model.mockImplementation(async (session, turn) => { seen.push(turn?.text ?? `continue:${session.currentTurn!.text}`); if (seen.length === 1) await gate.promise })
    const store = getStore(backend.api); await store.whenReady
    await store.send('Inspect moss'); await until(() => seen.length === 1)
    await store.send('Inspect fern'); store.stop(); await store.resumeQueue()
    expect(seen).toHaveLength(1)
    expect(backend.model.mock.calls[0][2].signal.aborted).toBe(true)
    gate.resolve(); await until(() => backend.project.mock.calls.length === 1)
    expect(store.getSnapshot().queuePaused).toBe(true)
    expect(store.getSnapshot().active?.pendingMessages).toHaveLength(1)
    await store.resumeQueue(); await until(() => backend.coordinator.snapshot(store.getSnapshot().active!.id)?.state === 'IDLE')
    expect(seen).toEqual(['Inspect moss', 'continue:Inspect moss', 'Inspect fern'])
    expect(store.getSnapshot().active!.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['Inspect moss', 'Inspect fern'])
  })

  it('steers at a completed tool boundary without cancelling or repeating its side effect', async () => {
    const backend = fixture(), gate = backend.gate()
    backend.model.mockImplementation(async (_session, _turn, controls) => {
      if (backend.model.mock.calls.length !== 1) return
      await controls.state('AWAITING_TOOLS'); await controls.state('EXECUTING_TOOLS')
      await controls.message({ id: 'completed-result', role: 'tool', toolCallId: 'completed', content: 'Moss inventory' })
      await gate.promise
      if (controls.shouldSteer()) throw new Error('Yield at tool boundary')
    })
    const store = getStore(backend.api); await store.whenReady
    await store.send('Inspect plants')
    const id = store.getSnapshot().active!.id
    await until(() => backend.coordinator.snapshot(id)?.state === 'EXECUTING_TOOLS')
    await store.send('Later'); await store.send('Focus on moss')
    await store.steerQueued(store.getSnapshot().active!.pendingMessages![1].id)
    const controls = backend.model.mock.calls[0][2]
    expect(controls.shouldSteer()).toBe(true); expect(controls.signal.aborted).toBe(false)
    expect(backend.model).toHaveBeenCalledTimes(1)
    gate.resolve(); await until(() => backend.coordinator.snapshot(id)?.state === 'IDLE')
    const messages = store.getSnapshot().active!.messages
    expect(messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['Inspect plants', 'Focus on moss', 'Later'])
    expect(messages.filter(message => message.toolCallId === 'completed')).toHaveLength(1)
  })

  it('reopens a failed session with its queue paused and does not infer again until Continue', async () => {
    const backend = fixture(), gate = backend.gate()
    backend.model.mockImplementationOnce(async () => { await gate.promise; throw new Error('Connection failed') })
    let store = getStore(backend.api); await store.whenReady
    await store.send('Inspect plants'); await until(() => backend.model.mock.calls.length === 1)
    await store.send('Next message'); gate.resolve()
    const id = store.getSnapshot().active!.id
    await until(() => backend.coordinator.snapshot(id)?.state === 'FAILED')
    expect(store.getSnapshot().error).toContain('Connection failed')
    await disposeStore(backend.api)
    store = getStore(backend.api); await store.whenReady; await store.openChat(id)
    expect(store.getSnapshot().queuePaused).toBe(true)
    expect(store.getSnapshot().active!.pendingMessages?.[0].text).toBe('Next message')
    expect(backend.model).toHaveBeenCalledTimes(1)
    await store.resumeQueue(); await until(() => backend.coordinator.snapshot(id)?.state === 'IDLE')
    expect(store.getSnapshot().active!.pendingMessages).toEqual([])
    expect(backend.model).toHaveBeenCalledTimes(3)
  })
})

it('keeps draft properties and navigation in memory until the first durable submission', async () => {
  const backend = fixture(), store = getStore(backend.api); await store.whenReady
  const id = store.getSnapshot().active!.id
  store.setModelOverride({ provider: 'deepseek', model: 'deepseek-flash', connectionId: 'deepseek' })
  store.setReasoningEffort('max'); await updateConversation(backend.api, id, { title: 'Fern draft', pinned: true })
  store.setDraft(id, 'Inspect the fern', [])
  store.newChat(); await store.openChat(id)
  expect(store.getSnapshot().active).toMatchObject({ id, title: 'Fern draft', reasoningEffort: 'max', pinned: true })
  expect(store.getDraft(id).text).toBe('Inspect the fern')
  expect(backend.driverCalls.filter(call => call.method === 'saveChat')).toEqual([])
  await store.send('Describe the fern'); await until(() => backend.coordinator.snapshot(id)?.state === 'IDLE')
  expect(backend.model.mock.calls[0][0].thread).toMatchObject({ id, title: 'Fern draft', pinned: true, model: { provider: 'deepseek', model: 'deepseek-flash' }, reasoningEffort: 'max' })
  await store.reloadThreads()
  expect(store.getSnapshot().threads.filter(thread => thread.id === id)).toHaveLength(1)
})

it('discards unused project drafts on restart and saves exactly one attachment-only conversation', async () => {
  const backend = fixture(); let store = getStore(backend.api); await store.whenReady
  for (let i = 0; i < 4; i++) { store.newChat(); await store.setProject('forest'); store.setReasoningEffort('high') }
  expect(backend.chatThreads.size).toBe(0)
  await disposeStore(backend.api)
  store = getStore(backend.api); await store.whenReady
  expect(store.getSnapshot().threads).toEqual([])
  const id = store.getSnapshot().active!.id
  await store.send('', [{ id: 'fern-image', path: 'attachment/fern.png', fileName: 'fern.png', kind: 'image' }])
  await until(() => backend.coordinator.snapshot(id)?.state === 'IDLE')
  expect([...backend.chatThreads.keys()]).toEqual([id])
  expect(backend.chatThreads.get(id)?.messages[0]).toMatchObject({ role: 'user', attachmentIds: ['fern-image'] })
  await disposeStore(backend.api)
  store = getStore(backend.api); await store.whenReady
  expect(store.getSnapshot().active?.id).toBe(id)
  expect(backend.model).toHaveBeenCalledTimes(1)
})
