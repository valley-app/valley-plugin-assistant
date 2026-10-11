import { describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from './mock'
import { registerHarnessCommands } from '../src/harnessCommands'
import { changeConversation, registerAssistantCommands } from '../src/commands'
import { registerSealedTestCommands } from '../src/sealedTestCommands'
import { disposeStore, getStore } from '../src/store'
import { initLocalization } from '../src/localization'
import config from '../config.json'
import Ajv from 'ajv'
import { assistantResults } from '../src/commandResults'

describe('package-owned harness commands', () => {
  it('returns typed saved conversation effects and restores the exact fixture after undo', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    const thread = { id: 'fern', title: 'Fern', createdAt: 1, updatedAt: 1, messages: [], pinned: true }
    mock.chatThreads.set(thread.id, thread)
    const baseline = JSON.stringify([...mock.chatThreads])
    const store = getStore(mock.api)
    await store.whenReady
    const off = registerAssistantCommands(mock.api)
    const validator = new Ajv({ strict: false })
    const invoke = async (id: string, input?: unknown) => {
      const command = mock.commands.find(item => item.id === id)!
      const parsed = command.input ? command.input.parse(input) : undefined
      const result = await command.run(parsed, {} as never)
      const value = command.sideEffect === 'write' ? (result as { value: unknown }).value : result
      expect(validator.validate(assistantResults[id], value), JSON.stringify(validator.errors)).toBe(true)
      return result
    }
    try {
      await invoke('list-chats')
      await invoke('read-chat', { id: thread.id })
      await invoke('read-memory', { id: thread.id })
      const changed = await invoke('update-properties', { subject: { pluginId: 'assistant', item: { id: thread.id } }, values: { pinned: false, model: null, profileId: '', commands: [] } }) as { value: unknown; revert: { run(): Promise<void> } }
      expect(mock.chatThreads.get(thread.id)).toMatchObject({ pinned: false, model: null, commands: [] })
      await changed.revert.run()
      expect(JSON.stringify([...mock.chatThreads])).toBe(baseline)
      const created = await invoke('create-chat', { title: 'Disposable' }) as { value: { id: string }; revert: { run(): Promise<void> } }
      expect(mock.chatThreads.has(created.value.id)).toBe(true)
      await created.revert.run()
      expect(JSON.stringify([...mock.chatThreads])).toBe(baseline)
      const stop = vi.spyOn(store, 'stop')
      expect(mock.commands.find(item => item.id === 'stop-chat')?.sideEffect).toBe('execute')
      expect(await invoke('stop-chat', { id: thread.id })).toEqual({ id: thread.id, stopped: true })
      expect(stop).toHaveBeenCalledWith(thread.id)
    } finally { off(); await disposeStore(mock.api) }
  })
  it('waits for the conversation terminal result before reporting send-message success', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    const thread = { id: 'fern', title: 'Fern', createdAt: 1, updatedAt: 1, messages: [] }
    mock.chatThreads.set(thread.id, thread)
    const store = getStore(mock.api)
    await store.whenReady
    let finish!: (value: unknown) => void
    const operation = vi.spyOn(mock.api.backend, 'callOperation').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const off = registerAssistantCommands(mock.api)
    try {
      const command = mock.commands.find(item => item.id === 'send-message')!
      let returned = false
      const sent = command.run({ id: thread.id, text: 'Read the note fern.md' }, {} as never)
      void Promise.resolve(sent).then(() => { returned = true })
      await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce())
      expect(returned).toBe(false)
      expect(operation).toHaveBeenCalledWith('command.session.submit', { id: expect.any(String), conversationId: thread.id, text: 'Read the note fern.md' }, { cancellation: undefined })
      const completed = { ...thread, messages: [{ role: 'assistant', content: 'Fern contents' }] }
      finish({ state: 'IDLE', error: null, thread: completed })
      const result = await sent
      expect(result).toEqual({ value: completed, revert: null })
      expect(new Ajv({ strict: false }).validate(assistantResults['send-message'], (result as { value: unknown }).value)).toBe(true)
      operation.mockRejectedValueOnce(new Error('No progress while waiting for provider output'))
      await expect(command.run({ id: thread.id, text: 'Read the note fern.md' }, {} as never)).rejects.toThrow('No progress')
    } finally { off(); await disposeStore(mock.api) }
  })
  it('registers declared legacy aliases and releases every command', () => {
    const mock = createMockValleyApi({ manifest: { id: 'renamed-assistant' } })
    const dispose = registerHarnessCommands(mock.api)
    expect(mock.commands.map((command) => command.id).sort()).toEqual(Object.entries(config.commandAliases).filter(([alias]) => alias.startsWith('harness:')).map(([, id]) => id).sort())
    expect(Object.keys(config.commandAliases)).toContain('harness:run')
    expect(mock.commands.every((command) => command.paletteSafe === false)).toBe(true)
    dispose()
    expect(mock.commands).toHaveLength(0)
  })

  it('reads current provider status through its owning API when the plugin is renamed', async () => {
    const providers = [{ provider: 'fixture', configured: true, models: [] }, { provider: 'other', configured: false, models: [] }]
    const mock = createMockValleyApi({ manifest: { id: 'renamed-assistant' }, aiProviders: providers })
    initLocalization(mock.api)
    const call = vi.spyOn(mock.api.assistant, 'providerStatus')
    const dispose = registerAssistantCommands(mock.api)
    try {
      await getStore(mock.api).whenReady
      const command = mock.commands.find((item) => item.id === config.commandAliases['providers:reload'])!
      const result = await command.run(undefined, {} as never)
      expect(result).toEqual({ providers })
      expect(command.sideEffect).toBe('read')
      expect(call).toHaveBeenCalledWith()
      expect(new Ajv({ strict: false }).validate(assistantResults['providers-reload'], result)).toBe(true)
      expect(command.formatCli?.(result)).toBe('Providers reloaded: 1.')
      call.mockRejectedValueOnce(new Error('Provider module unavailable'))
      await expect(command.run(undefined, {} as never)).rejects.toThrow('Provider module unavailable')
    } finally {
      dispose()
      disposeStore()
    }
    expect(mock.commands).toHaveLength(0)
  })

  it('preserves CLI model parsing and sends harness work to its own backend', async () => {
    const mock = createMockValleyApi()
    const run = { id: 'run-one', harnessId: 'jarvis', harnessVersion: '1', sourceDigest: 'fixture', startedAt: 1, status: 'running', options: { useCache: true, concurrency: 4 }, targets: [] }
    const call = vi.spyOn(mock.api.backend, 'call').mockResolvedValue({ run })
    const dispose = registerHarnessCommands(mock.api)
    const command = mock.commands.find((item) => item.id === 'harness-run')!
    const raw = command.input!.fromCli!(['jarvis', 'openai:model:variant'], { connection: 'work', 'use-cache': true, concurrency: '4' })
    const input = command.input!.parse(raw)
    const result = await command.run(input, {} as never)
    expect(result).toEqual({ value: { run }, revert: null })
    expect(new Ajv({ strict: false }).validate(assistantResults['harness-run'], (result as { value: unknown }).value)).toBe(true)
    expect(call).toHaveBeenCalledWith('ai.runHarness', { id: 'jarvis', targets: [{ provider: 'openai', model: 'model:variant', connectionId: 'work' }], options: { useCache: true, concurrency: 4 } })
    await expect(command.run({ id: 'jarvis', targets: ['invalid'] }, {} as never)).rejects.toThrow()
    expect(call).toHaveBeenCalledTimes(1)
    dispose()
  })

  it.each(['clear-chat', 'delete-chat'] as const)('returns a %s revert that restores the backend capture while the chat is unchanged', async (operation) => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    const thread = { id: 'fern', title: 'Fern', createdAt: 1, updatedAt: 1, messages: [{ role: 'user' as const, content: 'Moss' }] }
    mock.chatThreads.set(thread.id, structuredClone(thread))
    const store = getStore(mock.api)
    await store.whenReady
    const snapshot = { id: thread.id, entries: [{ path: 'settings.json', kind: 'file', base64: 'e30=' }] }, revision = 'a'.repeat(64)
    const callOperation = vi.spyOn(mock.api.backend, 'callOperation').mockImplementation(async (method: string, payload?: unknown) => {
      if (method === 'chat.capture') return (payload as { id: string }).id === thread.id ? snapshot : null
      if (method === 'chat.revision') return mock.chatThreads.has(thread.id) && operation === 'delete-chat' ? 'b'.repeat(64) : revision
      if (method === 'chat.restore') { expect(payload).toEqual({ snapshot, expectedRevision: revision }); mock.chatThreads.set(thread.id, structuredClone(thread)); return null }
      throw new Error(`unexpected ${method}`)
    })
    const off = registerAssistantCommands(mock.api)
    try {
      const command = mock.commands.find(item => item.id === operation)!
      expect(await command.revision!({ id: thread.id })).toBe(operation === 'delete-chat' ? 'b'.repeat(64) : revision)
      const result = await command.run(command.input!.parse({ id: thread.id }), {} as never) as { value: unknown; revert: { run(): Promise<void> } }
      expect(result.value).toEqual({ id: thread.id, operation })
      expect(mock.chatThreads.has(thread.id)).toBe(false)
      await result.revert.run()
      expect(mock.chatThreads.get(thread.id)).toEqual(thread)
      expect(callOperation.mock.calls.map(([method]) => method)).toEqual(['chat.revision', 'chat.capture', 'chat.revision', 'chat.restore'])
      callOperation.mockClear()
      await changeConversation(mock.api, thread.id, operation)
      expect(callOperation).not.toHaveBeenCalled()
    } finally { off(); await disposeStore(mock.api) }
  })

  it('returns a harness-clear-cache revert that restores the captured entries and none for an absent cache', async () => {
    const mock = createMockValleyApi()
    const snapshot = { harnessId: 'jarvis', entries: [{ name: 'a.json', base64: 'e30=' }] }
    const call = vi.spyOn(mock.api.backend, 'call').mockImplementation(async (method: string, payload?: unknown) => {
      const id = (payload as { id?: string })?.id
      if (method === 'ai.captureHarnessCache') return id === 'jarvis' ? snapshot : null
      if (method === 'ai.clearHarnessCache') return { ok: true }
      if (method === 'ai.harnessCacheRevision') return 'c'.repeat(64)
      if (method === 'ai.restoreHarnessCache') return { ok: true }
      throw new Error(`unexpected ${method}`)
    })
    const dispose = registerHarnessCommands(mock.api)
    const command = mock.commands.find((item) => item.id === 'harness-clear-cache')!
    const result = await command.run({ id: 'jarvis' }, {} as never) as { value: unknown; revert: { run(): Promise<void> } }
    expect(result.value).toEqual({ ok: true })
    await result.revert.run()
    expect(call.mock.calls.map(([method]) => method)).toEqual(['ai.captureHarnessCache', 'ai.clearHarnessCache', 'ai.harnessCacheRevision', 'ai.restoreHarnessCache'])
    expect(call).toHaveBeenLastCalledWith('ai.restoreHarnessCache', { snapshot, expectedRevision: 'c'.repeat(64) })
    expect(await command.run({ id: 'absent' }, {} as never)).toEqual({ value: { ok: true }, revert: null })
    expect(await command.revision!({ id: 'jarvis' })).toBe('c'.repeat(64))
    dispose()
  })

  it('publishes the sealed-test forget commands only after the backend probe answers true and routes them to the backend', async () => {
    const ids = ['test-session-capture', 'test-session-forget', 'test-harness-capture', 'test-harness-forget']
    for (const answer of [false, undefined, new Error('unavailable')]) {
      const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
      vi.spyOn(mock.api.backend, 'call').mockImplementation(async () => { if (answer instanceof Error) throw answer; return answer })
      const off = registerSealedTestCommands(mock.api)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(mock.commands.filter(item => ids.includes(item.id))).toEqual([])
      off()
    }
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    const probe = vi.spyOn(mock.api.backend, 'call').mockImplementation(async (method: string) => method === 'test.sealed'), callOperation = vi.spyOn(mock.api.backend, 'callOperation').mockImplementation(async (method: string, payload?: unknown) => ({ method, payload }))
    const forgetSession = vi.spyOn(getStore(mock.api), 'forgetSession').mockResolvedValue()
    const off = registerSealedTestCommands(mock.api)
    try {
      await vi.waitFor(() => expect(mock.commands.filter(item => ids.includes(item.id)).map(item => [item.id, item.sideEffect])).toEqual([['test-session-capture', 'read'], ['test-session-forget', 'write'], ['test-harness-capture', 'read'], ['test-harness-forget', 'write']]))
      const command = (id: string) => mock.commands.find(item => item.id === id)!
      expect(() => command('test-session-forget').input!.parse({ captureId: 'a', conversationId: 'b', extra: 1 })).toThrow()
      expect(await command('test-session-forget').run(command('test-session-forget').input!.parse({ captureId: 'a', conversationId: 'fern' }), {} as never)).toEqual({ value: { method: 'test.forgetSession', payload: { captureId: 'a', conversationId: 'fern' } }, revert: null })
      expect(forgetSession).toHaveBeenCalledWith('fern')
      expect(await command('test-harness-capture').run(command('test-harness-capture').input!.parse({ id: 'jarvis' }), {} as never)).toEqual({ method: 'test.captureHarness', payload: { id: 'jarvis' } })
      expect(probe.mock.calls.map(([method]) => method)).toEqual(['test.sealed']); expect(callOperation.mock.calls.map(([method]) => method)).toEqual(['test.forgetSession', 'test.captureHarness'])
    } finally { off(); await disposeStore(mock.api) }
  })
})
