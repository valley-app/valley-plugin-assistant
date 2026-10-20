import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiChatThread } from '../src/types'
import type { RuntimeHooks } from '../src/backend/runtimes'
import { createBackendChannelFixture, channelFixture } from './backendChannelFixture'
import { scheduleChatNaming } from '../src/backend/chatNaming'
import { admitTurn } from '../src/backend/engine/responsiveness'
import * as threads from '../src/backend/threads'
import { record } from '../src/backend/persistence/repositories'
import { clarifyInstruction, replyShapeInstruction, stoppedNote } from '../src/backend/engine/replyShape'

const thread = (): AiChatThread => ({ id: 'local-fern', title: 'Open the app', titleOrigin: 'fallback', createdAt: 1, updatedAt: 1, messages: [] })
afterEach(() => vi.useRealTimers())

describe('active backend turn responsiveness', () => {
  it('bounds loading before enqueue and fences a late read without starting inference', async () => {
    vi.useFakeTimers()
    const test = createBackendChannelFixture(), chat = thread()
    let release!: (value: AiChatThread) => void
    const read = vi.spyOn(threads, 'readChat').mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    try {
      const submit = admitTurn(admission => test.runtime.submit({ id: 'loading', conversationId: chat.id, text: 'Create fern.md\nFern and moss', thread: chat }, test.api, admission))
      const failed = expect(submit).rejects.toThrow('loading the conversation for 10 seconds')
      await vi.advanceTimersByTimeAsync(10000); await failed
      expect(channelFixture.infer).not.toHaveBeenCalled()
      release(chat); await vi.advanceTimersByTimeAsync(0)
      expect((await test.data.dataset('turn_queue').get({ id: 'loading' }))?.state).toBe('REMOVED')
      expect(channelFixture.infer).not.toHaveBeenCalled()
    } finally { read.mockRestore() }
  })
  it.each(['enqueued', 'admission.accepted'])('never dispatches a %s commit that settles after admission expires', async stage => {
    vi.useFakeTimers()
    const test = createBackendChannelFixture(), chat = thread(), original = test.data.transaction
    let release!: () => void, held = false
    vi.spyOn(test.data, 'transaction').mockImplementation(async operations => {
      if (!held && operations.some(operation => operation.dataset === 'session_events' && 'values' in operation && !Array.isArray(operation.values) && operation.values?.state === stage)) { held = true; await new Promise<void>(resolve => { release = resolve }) }
      return original(operations)
    })
    const observed = test.emit
    const submit = admitTurn(admission => test.runtime.submit({ id: 'late-commit', conversationId: chat.id, text: 'Create fern.md', thread: chat }, test.api, admission))
    const failed = expect(submit).rejects.toThrow('10 seconds')
    await vi.advanceTimersByTimeAsync(10000); await failed
    expect(channelFixture.infer).not.toHaveBeenCalled()
    release(); await vi.advanceTimersByTimeAsync(0)
    expect(test.runtime.coordinator.snapshot(chat.id)?.queue).toEqual([])
    expect((await test.data.dataset('turn_queue').get({ id: 'late-commit' }))?.state).toBe('REMOVED')
    expect(observed.mock.calls.some(([, value]) => value.event?.type === 'admission.accepted')).toBe(false)
    await admitTurn(admission => test.runtime.submit({ id: 'late-commit', conversationId: chat.id, text: 'Create fern.md', thread: chat }, test.api, admission))
    expect(channelFixture.infer).not.toHaveBeenCalled()
    await admitTurn(admission => test.runtime.submit({ id: 'fresh-turn', conversationId: chat.id, text: 'Read fern.md', thread: chat }, test.api, admission))
    await test.runtime.coordinator.waitForTurn(chat.id, 'fresh-turn')
    expect(channelFixture.infer).toHaveBeenCalledOnce()
  })
  it('uses only background queue cleanup after scoped admission cancellation and preserves the tombstone', async () => {
    vi.useFakeTimers()
    const test = createBackendChannelFixture(), chat = thread(), controller = new AbortController()
    let release!: () => void
    const owner = { ...test.api, data: { ...test.data, transaction: vi.fn<typeof test.data.transaction>(async operations => {
      if (operations.some(operation => operation.dataset === 'session_events' && 'values' in operation && !Array.isArray(operation.values) && operation.values?.state === 'enqueued')) {
        await test.data.transaction(operations)
        await new Promise<void>(resolve => { release = resolve })
        throw new Error('Admission owner revoked after persistence')
      }
      return test.data.transaction(operations)
    }) } }
    const input = { id: 'cancelled-admission', conversationId: chat.id, text: 'Create fern.md', thread: chat }
    const submit = admitTurn(admission => test.runtime.submit(input, owner, admission), controller.signal)
    const failed = expect(submit).rejects.toThrow('admission cancelled')
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(); await failed
    release(); await vi.advanceTimersByTimeAsync(0)
    expect(channelFixture.infer).not.toHaveBeenCalled()
    expect((await test.data.dataset('turn_queue').get({ id: input.id }))?.state).toBe('REMOVED')
    await expect(admitTurn(admission => test.runtime.submit(input, test.api, admission))).rejects.toThrow('removed conversation')
    expect(channelFixture.infer).not.toHaveBeenCalled()
  })
  it('keeps late acceptance fenced when writing its cancellation receipt fails', async () => {
    vi.useFakeTimers()
    const test = createBackendChannelFixture(), chat = thread(), original = test.data.transaction
    let release!: () => void, held = false
    vi.spyOn(test.data, 'transaction').mockImplementation(async operations => {
      const event = operations.find(operation => operation.dataset === 'session_events' && 'values' in operation && !Array.isArray(operation.values))
      const stage = event && 'values' in event && !Array.isArray(event.values) ? event.values?.state : undefined
      if (!held && stage === 'admission.accepted') { held = true; const result = await original(operations); await new Promise<void>(resolve => { release = resolve }); return result }
      if (stage === 'admission.rejected') throw new Error('Cancellation journal unavailable')
      return original(operations)
    })
    const submit = admitTurn(admission => test.runtime.submit({ id: 'late-uncertain', conversationId: chat.id, text: 'Create fern.md', thread: chat }, test.api, admission))
    const failed = expect(submit).rejects.toThrow('10 seconds')
    await vi.advanceTimersByTimeAsync(10000); await failed
    release(); await vi.advanceTimersByTimeAsync(0)
    expect(test.runtime.coordinator.snapshot(chat.id)?.queue[0]).toMatchObject({ id: 'late-uncertain', editing: true, admissionPending: true })
    expect(channelFixture.infer).not.toHaveBeenCalled()
    await admitTurn(admission => test.runtime.submit({ id: 'fresh-safe', conversationId: chat.id, text: 'Read fern.md', thread: chat }, test.api, admission))
    await test.runtime.coordinator.waitForTurn(chat.id, 'fresh-safe')
    expect(channelFixture.infer).toHaveBeenCalledOnce()
    expect(test.runtime.coordinator.snapshot(chat.id)?.queue[0]).toMatchObject({ id: 'late-uncertain', admissionPending: true })
  })
  it('passes only the captured opaque target from the admitted turn into its agent scope', async () => {
    const test = createBackendChannelFixture(), chat = thread()
    await test.runtime.submit({ id: 'targeted', conversationId: chat.id, text: 'Open the calendar app', thread: chat, targetReference: 'captured-document-reference' })
    await test.runtime.coordinator.waitForTurn(chat.id, 'targeted')
    expect(test.api.agent.begin).toHaveBeenCalledWith(expect.objectContaining({ conversationId: chat.id, targetReference: 'captured-document-reference' }))
    expect(await test.runtime.repository.get('turn_queue', 'targeted')).toMatchObject({ targetReference: 'captured-document-reference' })
  })
  it('starts the native request without title or project discovery calls and ignores heartbeat noise', async () => {
    vi.useFakeTimers()
    const test = createBackendChannelFixture(), chat = thread()
    channelFixture.settings.automaticChatNaming = true
    let hooks!: RuntimeHooks
    channelFixture.infer.mockImplementation(async (_input, _context, value) => { hooks = value; await new Promise(() => {}) })
    await test.runtime.submit({ id: 'open', conversationId: chat.id, text: 'Open the calendar app in a new tab', thread: chat })
    const failed = expect(test.runtime.coordinator.waitForTurn(chat.id, 'open')).rejects.toThrow('No progress while starting the conversation model for 10 seconds')
    await vi.advanceTimersByTimeAsync(0)
    expect(test.api.agent.catalog).not.toHaveBeenCalled()
    expect(test.api.agent.describe).not.toHaveBeenCalled()
    expect(channelFixture.infer.mock.calls[0][0].request.tools.some((tool: { name: string }) => tool.name === 'name_conversation')).toBe(false)
    expect(scheduleChatNaming).not.toHaveBeenCalled()
    for (let i = 0; i < 3; i++) { await vi.advanceTimersByTimeAsync(3000); hooks.event({ type: 'heartbeat' }); hooks.event({ type: 'log', text: 'Still alive' }) }
    await vi.advanceTimersByTimeAsync(1000)
    await failed
    expect(test.runtime.coordinator.snapshot(chat.id)).toMatchObject({ state: 'FAILED', streamingText: '' })
  })
  it('waits longer than a host step for a slow provider answer after a tool, and still stops a silent provider', async () => {
    vi.useFakeTimers()
    const test = createBackendChannelFixture(), chat = thread()
    vi.mocked(test.api.agent.describe).mockResolvedValue({ id: 'notes.read', description: 'Read a note', effect: 'read', retry: 'safe', available: true, location: 'backend', parameters: { type: 'object' } })
    vi.mocked(test.api.agent.invoke).mockResolvedValue({ content: 'Fern' })
    channelFixture.infer.mockImplementation(async (_input, _context, hooks: RuntimeHooks) => {
      await hooks.tool({ id: 'read', name: 'command_execute', arguments: { command: 'notes.read', arguments: { path: 'fern.md' } } })
      await new Promise(resolve => setTimeout(resolve, 30000))
      hooks.event({ type: 'message', message: { role: 'assistant', content: 'Fern says Fern.' } })
    })
    await test.runtime.submit({ id: 'slow', conversationId: chat.id, text: 'Read fern.md', thread: chat })
    const done = test.runtime.coordinator.waitForTurn(chat.id, 'slow')
    await vi.advanceTimersByTimeAsync(30000)
    await done
    expect(channelFixture.threads.get(chat.id)?.messages.at(-1)?.content).toBe('Fern says Fern.')
    channelFixture.infer.mockImplementation(async (_input, _context, hooks: RuntimeHooks) => {
      await hooks.tool({ id: 'read-again', name: 'command_execute', arguments: { command: 'notes.read', arguments: { path: 'moss.md' } } })
      await new Promise(() => {})
    })
    await test.runtime.submit({ id: 'silent', conversationId: chat.id, text: 'Read moss.md' })
    const failed = expect(test.runtime.coordinator.waitForTurn(chat.id, 'silent')).rejects.toThrow('No progress while waiting for the model response for 60 seconds')
    await vi.advanceTimersByTimeAsync(60000)
    await failed
  })
  it('defers automatic naming until the completed transcript is projected', async () => {
    const test = createBackendChannelFixture(), chat = thread()
    channelFixture.settings.automaticChatNaming = true
    channelFixture.infer.mockImplementation(async (_input, _context, hooks: RuntimeHooks) => {
      expect(scheduleChatNaming).not.toHaveBeenCalled()
      hooks.event({ type: 'message', message: { role: 'assistant', content: 'The app is open.' } })
    })
    await test.runtime.submit({ id: 'open', conversationId: chat.id, text: 'Open the calendar app', thread: chat })
    await test.runtime.coordinator.waitForTurn(chat.id, 'open')
    expect(channelFixture.threads.get(chat.id)?.messages.at(-1)?.content).toBe('The app is open.')
    expect(scheduleChatNaming).toHaveBeenCalledWith('/vault', chat.id, expect.objectContaining({ model: 'test-model' }), test.api)
  })
  it('ends an unresponsive accepted write while retaining the receipt and blocking a fresh-turn replay', async () => {
    vi.useFakeTimers()
    const test = createBackendChannelFixture(), chat = thread()
    vi.mocked(test.api.agent.describe).mockResolvedValue({ id: 'notes.write', description: 'Write a note', effect: 'write', retry: 'reconcile', available: true, location: 'backend', parameters: { type: 'object' } })
    vi.mocked(test.api.agent.invoke).mockImplementation(() => new Promise(() => {}))
    const outcomes: string[] = []
    channelFixture.infer.mockImplementation(async (_input, _context, hooks: RuntimeHooks) => {
      const result = await hooks.tool({ id: 'write', name: 'command_execute', arguments: { command: 'notes.write', arguments: { path: 'fern.md', content: 'Fern' } } })
      outcomes.push(result)
    })
    await test.runtime.submit({ id: 'first', conversationId: chat.id, text: 'Create the note fern.md', thread: chat })
    const failed = expect(test.runtime.coordinator.waitForTurn(chat.id, 'first')).rejects.toThrow('executing notes.write for 10 seconds')
    await vi.advanceTimersByTimeAsync(10000)
    await failed
    expect((await test.runtime.repository.rows('tool_executions'))[0]).toMatchObject({ state: 'UNKNOWN' })
    await test.runtime.submit({ id: 'second', conversationId: chat.id, text: 'Create the note fern.md' })
    await expect(test.runtime.coordinator.waitForTurn(chat.id, 'second')).rejects.toThrow('UNKNOWN_PREVIOUS_OUTCOME')
    expect(test.api.agent.invoke).toHaveBeenCalledOnce()
    expect(outcomes).toEqual([])
    expect(JSON.parse(test.runtime.coordinator.snapshot(chat.id)!.thread!.messages.at(-2)!.content)).toMatchObject({ success: false, error: { code: 'UNKNOWN_PREVIOUS_OUTCOME' } })
    expect(test.runtime.coordinator.snapshot(chat.id)!.thread!.messages.at(-1)).toMatchObject({ role: 'assistant', error: true, content: expect.stringContaining('This request failed and did not finish: UNKNOWN_PREVIOUS_OUTCOME') })
  })
  it.each(['not-applied', 'unknown'])('ends a nonrecoverable command failure without model continuation or alternate dispatch (%s)', async outcome => {
    const test = createBackendChannelFixture(), chat = thread(), continued = vi.fn()
    vi.mocked(test.api.agent.describe).mockResolvedValue({ id: 'notes.write', description: 'Write a note', effect: 'write', retry: 'reconcile', available: true, location: 'renderer', parameters: { type: 'object' } })
    vi.mocked(test.api.agent.invoke).mockRejectedValue(Object.assign(new Error('The originating application window is unavailable'), { code: 'TARGET_REQUIRED', outcome, retryable: false }))
    channelFixture.infer.mockImplementation(async (_input, _context, hooks: RuntimeHooks) => {
      await hooks.tool({ id: 'write', name: 'command_execute', arguments: { command: 'notes.write', arguments: { path: 'fern.md', content: 'Fern' } } })
      continued()
      await hooks.tool({ id: 'alternate', name: 'command_execute', arguments: { command: 'notes.create', arguments: { path: 'fern.md', content: 'Fern' } } })
    })
    await test.runtime.submit({ id: 'first', conversationId: chat.id, text: 'Create the note fern.md', thread: chat })
    await expect(test.runtime.coordinator.waitForTurn(chat.id, 'first')).rejects.toThrow('TARGET_REQUIRED: This action needs an open Valley window')
    expect(continued).not.toHaveBeenCalled()
    expect(test.api.agent.invoke).toHaveBeenCalledOnce()
    const session = test.runtime.coordinator.snapshot(chat.id)!
    expect(session).toMatchObject({ state: 'FAILED', streamingText: '', paused: true })
    expect(JSON.parse(session.thread!.messages.at(-2)!.content)).toMatchObject({ success: false, error: { code: 'TARGET_REQUIRED', recoverable: false } })
    expect(session.thread!.messages.at(-1)).toMatchObject({ role: 'assistant', error: true, failure: session.error })
    expect((await test.runtime.repository.rows('tool_executions'))[0]).toMatchObject({ state: outcome === 'unknown' ? 'UNKNOWN' : 'COMPLETED' })
  })
  it.each([
    ['This target is unavailable and nothing was opened. For a file or folder, bookmark.folderPath is its full vault-relative path (a file includes its extension).', true],
    ['The application window or document is unavailable', false],
    ['Select an available application window ID from windows:list', false]
  ])('keeps a refused navigation target correctable unless the window is gone (%s)', async (message, recoverable) => {
    const test = createBackendChannelFixture(), chat = thread()
    vi.mocked(test.api.agent.describe).mockResolvedValue({ id: 'navigation:open', description: 'Open a target', effect: 'write', retry: 'reconcile', available: true, location: 'renderer', parameters: { type: 'object' } })
    vi.mocked(test.api.agent.invoke).mockRejectedValueOnce(Object.assign(new Error(message), { code: 'TARGET_UNAVAILABLE', outcome: 'not-applied' })).mockResolvedValueOnce({ opened: true })
    channelFixture.infer.mockImplementation(async (_input, _context, hooks: RuntimeHooks) => {
      expect(JSON.parse(await hooks.tool({ id: 'open', name: 'command_execute', arguments: { command: 'navigation:open', arguments: { bookmark: { folderPath: 'readiness' } } } }))).toMatchObject({ success: false, error: { code: 'TARGET_UNAVAILABLE', recoverable } })
      await hooks.tool({ id: 'corrected', name: 'command_execute', arguments: { command: 'navigation:open', arguments: { bookmark: { folderPath: 'readiness/fern.md' } } } })
    })
    await test.runtime.submit({ id: 'first', conversationId: chat.id, text: 'Open fern.md', thread: chat })
    const turn = test.runtime.coordinator.waitForTurn(chat.id, 'first')
    if (recoverable) await turn; else await expect(turn).rejects.toThrow('TARGET_UNAVAILABLE')
    expect(test.api.agent.invoke).toHaveBeenCalledTimes(recoverable ? 2 : 1)
  })
  it('keeps a recoverable no-effect error available for corrected input', async () => {
    const test = createBackendChannelFixture(), chat = thread()
    vi.mocked(test.api.agent.describe).mockResolvedValue({ id: 'notes.write', description: 'Write a note', effect: 'write', retry: 'reconcile', available: true, location: 'backend', parameters: { type: 'object' } })
    vi.mocked(test.api.agent.invoke).mockRejectedValueOnce(Object.assign(new Error('Revision changed'), { code: 'REVISION_CONFLICT', outcome: 'not-applied', retryable: false })).mockResolvedValueOnce({ written: true })
    channelFixture.infer.mockImplementation(async (_input, _context, hooks: RuntimeHooks) => {
      const failed = JSON.parse(await hooks.tool({ id: 'write', name: 'command_execute', arguments: { command: 'notes.write', arguments: { revision: 1 } } }))
      expect(failed).toMatchObject({ success: false, error: { recoverable: true } })
      expect(JSON.parse(await hooks.tool({ id: 'corrected', name: 'command_execute', arguments: { command: 'notes.write', arguments: { revision: 2 } } }))).toMatchObject({ success: true })
    })
    await test.runtime.submit({ id: 'first', conversationId: chat.id, text: 'Create the note fern.md', thread: chat })
    await test.runtime.coordinator.waitForTurn(chat.id, 'first')
    expect(test.api.agent.invoke).toHaveBeenCalledTimes(2)
  })
  it('returns a failed read command to the model to correct, but keeps a failed write unknown', async () => {
    const test = createBackendChannelFixture(), chat = thread()
    vi.mocked(test.api.agent.describe).mockImplementation(async (_scope: string, id: string) => ({ id, description: id, effect: id === 'projects.read' ? 'read' : 'write', retry: id === 'projects.read' ? 'safe' : 'never', available: true, location: 'backend', parameters: { type: 'object' } }))
    vi.mocked(test.api.agent.invoke).mockRejectedValueOnce(Object.assign(new Error("ENOENT: no such file or directory, realpath '/Readiness/fern.md'"), { code: 'ENOENT' })).mockResolvedValueOnce({ content: 'Fern' }).mockRejectedValueOnce(Object.assign(new Error('Connection ended'), { code: 'COMMAND_CONNECTION_ENDED' }))
    channelFixture.infer.mockImplementation(async (_input, _context, hooks: RuntimeHooks) => {
      expect(JSON.parse(await hooks.tool({ id: 'read', name: 'command_execute', arguments: { command: 'projects.read', arguments: { path: 'Readiness/fern.md' } } }))).toMatchObject({ success: false, error: { code: 'ENOENT', recoverable: true } })
      expect(JSON.parse(await hooks.tool({ id: 'corrected', name: 'command_execute', arguments: { command: 'projects.read', arguments: { path: 'fern.md' } } }))).toMatchObject({ success: true })
      await hooks.tool({ id: 'write', name: 'command_execute', arguments: { command: 'notes.write', arguments: { path: 'fern.md', content: 'Fern' } } })
    })
    await test.runtime.submit({ id: 'first', conversationId: chat.id, text: 'Read fern.md, then write it', thread: chat })
    await test.runtime.coordinator.waitForTurn(chat.id, 'first').catch(() => undefined)
    const session = test.runtime.coordinator.snapshot(chat.id)!
    expect(test.api.agent.invoke).toHaveBeenCalledTimes(3)
    expect(session.state).toBe('FAILED')
    expect(JSON.parse(session.thread!.messages.at(-2)!.content)).toMatchObject({ success: false, error: { code: 'COMMAND_CONNECTION_ENDED', recoverable: false, outcomeUnknown: true } })
  })
})

describe('host approval inside a backend turn', () => {
  it('waits on the host challenge without the progress limit and returns the approved result to the same turn', async () => {
    vi.useFakeTimers()
    const test = createBackendChannelFixture(), chat = thread()
    let state: ((event: { scopeId: string; state: string; permitId?: string }) => void) | undefined
    let finish: ((record: unknown) => void) | undefined
    vi.mocked(test.api.agent.onState).mockImplementation(listener => { state = listener as typeof state; return () => {} })
    vi.mocked(test.api.agent.describe).mockResolvedValue({ id: 'command:plugin:forest:clear', description: 'Clear the forest', effect: 'write', retry: 'never', available: true, location: 'backend', parameters: { type: 'object' } })
    vi.mocked(test.api.agent.invoke).mockImplementation(() => new Promise(resolve => { finish = resolve; state!({ scopeId: 'scope', state: 'awaiting-approval' }) }))
    vi.mocked(test.api.agent.resume).mockImplementation(async () => { finish!({ id: 'execution-1', command: 'command:plugin:forest:clear', revision: 4, status: 'completed', result: { cleared: true } }) })
    const outcomes: unknown[] = []
    channelFixture.infer.mockImplementation(async (_input, _context, hooks: RuntimeHooks) => {
      outcomes.push(await hooks.tool({ id: 'clear', name: 'command_execute', arguments: { command: 'command:plugin:forest:clear', arguments: {} } }))
    })
    await test.runtime.submit({ id: 'approve', conversationId: chat.id, text: 'Clear the forest', thread: chat })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(test.runtime.coordinator.snapshot(chat.id)).toMatchObject({ state: 'AWAITING_APPROVAL' })
    expect(test.api.agent.resume).not.toHaveBeenCalled()
    state!({ scopeId: 'scope', state: 'running', permitId: 'permit-1' })
    await vi.advanceTimersByTimeAsync(0)
    await test.runtime.coordinator.waitForTurn(chat.id, 'approve')
    expect(test.api.agent.resume).toHaveBeenCalledWith('scope', 'permit-1')
    expect(test.api.agent.invoke).toHaveBeenCalledOnce()
    expect(outcomes.map(value => JSON.parse(String(value)))).toEqual([{ success: true, value: expect.objectContaining({ status: 'completed', result: { cleared: true } }) }])
    expect(test.runtime.coordinator.snapshot(chat.id)).toMatchObject({ state: 'IDLE' })
  })
})

describe('ten-second no-progress limit (readiness 4.7)', () => {
  const discoveryCall = { id: 'list', name: 'command_list', arguments: { filter: 'music', offset: 0, limit: 20 } }
  it('does not let repeated identical discovery keep a stalled turn alive', async () => {
    vi.useFakeTimers()
    const test = createBackendChannelFixture(), chat = thread()
    channelFixture.infer.mockImplementation(async (_input, _context, hooks: RuntimeHooks) => {
      for (let round = 0; round < 10; round++) {
        hooks.progress?.({ requestId: 'request', type: 'tool_call', call: { ...discoveryCall, id: `list-${round}` } })
        await hooks.tool({ ...discoveryCall, id: `list-${round}` })
        await new Promise(resolve => setTimeout(resolve, 4000))
      }
    })
    await test.runtime.submit({ id: 'rediscover', conversationId: chat.id, text: 'Find a song and play it', thread: chat })
    const failed = expect(test.runtime.coordinator.waitForTurn(chat.id, 'rediscover')).rejects.toThrow('after a repeated result for 10 seconds')
    await vi.advanceTimersByTimeAsync(12000)
    await failed
    expect(test.api.agent.catalog).toHaveBeenCalledTimes(3)
    expect(test.runtime.coordinator.snapshot(chat.id)).toMatchObject({ state: 'FAILED', paused: true })
  })
  it('keeps distinct discovery as progress', async () => {
    vi.useFakeTimers()
    const test = createBackendChannelFixture(), chat = thread()
    channelFixture.infer.mockImplementation(async (_input, _context, hooks: RuntimeHooks) => {
      for (let round = 0; round < 4; round++) {
        const call = { ...discoveryCall, id: `list-${round}`, arguments: { ...discoveryCall.arguments, offset: round * 20 } }
        hooks.progress?.({ requestId: 'request', type: 'tool_call', call })
        await hooks.tool(call)
        await new Promise(resolve => setTimeout(resolve, 4000))
      }
      hooks.event({ type: 'message', message: { role: 'assistant', content: 'Found it.' } })
    })
    await test.runtime.submit({ id: 'discover', conversationId: chat.id, text: 'Find a song and play it', thread: chat })
    const done = test.runtime.coordinator.waitForTurn(chat.id, 'discover')
    await vi.advanceTimersByTimeAsync(16000)
    await expect(done).resolves.toMatchObject({ state: 'IDLE' })
  })
  it('does not let the same call failing the same way keep a stalled turn alive', async () => {
    vi.useFakeTimers()
    const test = createBackendChannelFixture(), chat = thread()
    vi.mocked(test.api.agent.describe).mockResolvedValue({ id: 'notes.write', description: 'Write a note', effect: 'write', retry: 'reconcile', available: true, location: 'backend', parameters: { type: 'object' } })
    vi.mocked(test.api.agent.invoke).mockRejectedValue(Object.assign(new Error('Revision changed'), { code: 'REVISION_CONFLICT', outcome: 'not-applied', retryable: false }))
    channelFixture.infer.mockImplementation(async (_input, _context, hooks: RuntimeHooks) => {
      // Two identical failures stay under the call bound (4.9), so this checks the deadline alone.
      for (let round = 0; round < 2; round++) {
        const call = { id: `write-${round}`, name: 'command_execute', arguments: { command: 'notes.write', arguments: { revision: 1 } } }
        hooks.progress?.({ requestId: 'request', type: 'tool_call', call })
        await hooks.tool(call)
        await new Promise(resolve => setTimeout(resolve, 6000))
      }
    })
    await test.runtime.submit({ id: 'retry', conversationId: chat.id, text: 'Create the note fern.md', thread: chat })
    const failed = expect(test.runtime.coordinator.waitForTurn(chat.id, 'retry')).rejects.toThrow('after a repeated result for 10 seconds')
    await vi.advanceTimersByTimeAsync(12000)
    await failed
    expect(test.api.agent.invoke).toHaveBeenCalledTimes(2)
  })
  it('ends the turn when blocking work overran the deadline, even though the timer could not fire', async () => {
    vi.useFakeTimers()
    const test = createBackendChannelFixture(), chat = thread()
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      channelFixture.infer.mockImplementation(async (_input, _context, hooks: RuntimeHooks) => {
        now += 15000
        hooks.event({ type: 'message', message: { role: 'assistant', content: 'Late answer' } })
      })
      await test.runtime.submit({ id: 'stalled', conversationId: chat.id, text: 'Open the calendar app', thread: chat })
      await expect(test.runtime.coordinator.waitForTurn(chat.id, 'stalled')).rejects.toThrow('No progress while starting the conversation model for 10 seconds')
      expect(test.runtime.coordinator.snapshot(chat.id)!.thread!.messages.some(message => message.content === 'Late answer')).toBe(false)
    } finally { clock.mockRestore() }
  })
  it('names an accepted action that is still running with its reconciliation ID and never runs it again', async () => {
    vi.useFakeTimers()
    const test = createBackendChannelFixture(), chat = thread()
    vi.mocked(test.api.agent.describe).mockResolvedValue({ id: 'notes.write', description: 'Write a note', effect: 'write', retry: 'reconcile', available: true, location: 'backend', parameters: { type: 'object' } })
    vi.mocked(test.api.agent.invoke).mockImplementation(() => new Promise(() => {}))
    channelFixture.infer.mockImplementation(async (_input, _context, hooks: RuntimeHooks) => {
      await hooks.tool({ id: 'write', name: 'command_execute', arguments: { command: 'notes.write', arguments: { path: 'fern.md', content: 'Fern' } } })
    })
    await test.runtime.submit({ id: 'first', conversationId: chat.id, text: 'Create the note fern.md', thread: chat })
    const failed = test.runtime.coordinator.waitForTurn(chat.id, 'first').catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(10000)
    const error = await failed as Error
    const execution = (vi.mocked(test.api.agent.invoke).mock.calls[0] as unknown[])[3] as { correlationId: string; idempotencyKey: string }
    expect(execution.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(error.message).toContain(`notes.write may still finish in Valley; its reconciliation ID is ${execution.idempotencyKey}. It is not retried automatically.`)
    expect(test.runtime.coordinator.snapshot(chat.id)).toMatchObject({ state: 'FAILED', error: expect.stringContaining(execution.idempotencyKey) })
    expect(test.api.agent.invoke).toHaveBeenCalledOnce()
  })
})

describe('same behaviour on every surface', () => {
  it('lets a Telegram or WhatsApp turn act in the only open Valley window, and an in-app turn keep its own', async () => {
    const test = createBackendChannelFixture()
    for (const [source, id] of [['telegram', 'telegram-fern'], ['whatsapp', 'whatsapp-fern']] as const) {
      const chat = { ...thread(), id, source, channelId: `${source}-channel`, chatRef: '42' } as AiChatThread
      channelFixture.infer.mockImplementationOnce(async (_input, _context, hooks: RuntimeHooks) => { hooks.event({ type: 'message', message: { role: 'assistant', content: 'Paused.' } }) })
      await test.runtime.submit({ id: `${source}-turn`, conversationId: chat.id, text: 'Pause the music', thread: chat })
      // Delivery back to the provider is out of scope here; the fixture has no open WhatsApp reply window.
      await test.runtime.coordinator.waitForTurn(chat.id, `${source}-turn`).catch(() => {})
      expect(test.api.agent.begin).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: id, targetFallback: 'sole-window' }))
    }
    const local = thread()
    channelFixture.infer.mockImplementationOnce(async (_input, _context, hooks: RuntimeHooks) => { hooks.event({ type: 'message', message: { role: 'assistant', content: 'Paused.' } }) })
    await test.runtime.submit({ id: 'local-turn', conversationId: local.id, text: 'Pause the music', thread: local })
    await test.runtime.coordinator.waitForTurn(local.id, 'local-turn')
    expect(vi.mocked(test.api.agent.begin).mock.lastCall![0]).not.toHaveProperty('targetFallback')
  })
})

describe('reply shape on every surface', () => {
  const working = async (_input: unknown, _context: unknown, hooks: RuntimeHooks, order: string[]) => {
    hooks.event({ type: 'message', message: { id: 'opening', role: 'assistant', content: 'I will look up the song and play it.', toolCalls: [{ id: 'list', name: 'command_list', arguments: { filter: 'music' } }] } })
    await hooks.tool({ id: 'list', name: 'command_list', arguments: { filter: 'music' } })
    hooks.event({ type: 'message', message: { id: 'final', role: 'assistant', content: 'Playing Fern Song. Summary: found it in your library and started playback.' } })
  }
  it('tells the model to open with what it will do and end with a summary, in the app and on channels', async () => {
    const test = createBackendChannelFixture(), chat = thread()
    channelFixture.infer.mockImplementationOnce(async (_input, _context, hooks: RuntimeHooks) => { hooks.event({ type: 'message', message: { role: 'assistant', content: 'Done.' } }) })
    await test.runtime.submit({ id: 'local', conversationId: chat.id, text: 'Play Fern Song', thread: chat })
    await test.runtime.coordinator.waitForTurn(chat.id, 'local')
    expect((channelFixture.infer.mock.calls[0][0] as { request: { messages: Array<{ content: string }> } }).request.messages[0].content).toContain(replyShapeInstruction)
    expect((channelFixture.infer.mock.calls[0][0] as { request: { messages: Array<{ content: string }> } }).request.messages[0].content).toContain(clarifyInstruction)
    expect(channelFixture.dispatch).not.toHaveBeenCalled()
  })
  it('tells the model that a request the user stopped is not to be carried out unasked', async () => {
    const test = createBackendChannelFixture(), chat = { ...thread(), messages: [{ id: 'stopped-turn', role: 'user', content: 'Write 150 sentences about a stream', stopped: true, ts: 1 }] } as AiChatThread
    channelFixture.infer.mockImplementationOnce(async (_input, _context, hooks: RuntimeHooks) => { hooks.event({ type: 'message', message: { role: 'assistant', content: 'Done.' } }) })
    await test.runtime.submit({ id: 'after-stop', conversationId: chat.id, text: 'Create the clover note', thread: chat })
    await test.runtime.coordinator.waitForTurn(chat.id, 'after-stop')
    const messages = (channelFixture.infer.mock.calls[0][0] as { request: { messages: Array<{ id?: string; content: string }> } }).request.messages
    expect(messages.find(message => message.id === 'stopped-turn')).toEqual(expect.objectContaining({ content: `Write 150 sentences about a stream\n\n${stoppedNote}` }))
    expect(messages.find(message => message.id === 'stopped-turn')).not.toHaveProperty('stopped')
    expect(messages.find(message => message.id === 'after-stop')?.content).toBe('Create the clover note')
  })
  it('shows typing on Telegram and sends the opening line before the first tool runs, then the final answer', async () => {
    const test = createBackendChannelFixture(), order: string[] = []
    const chat = { ...thread(), id: 'telegram-fern', source: 'telegram', channelId: 'telegram-channel', chatRef: '42' } as AiChatThread
    vi.mocked(test.api.agent.catalog).mockImplementation(async () => { order.push(...channelFixture.activity.mock.calls.map(() => 'typing'), ...channelFixture.dispatch.mock.calls.map(call => (call[1] as { text?: string }).text ?? '')); return { commands: [], total: 0 } })
    channelFixture.infer.mockImplementationOnce((input, context, hooks: RuntimeHooks) => working(input, context, hooks, order))
    await test.runtime.submit({ id: 'telegram-turn', conversationId: chat.id, text: 'Play Fern Song', thread: chat })
    await test.runtime.coordinator.waitForTurn(chat.id, 'telegram-turn')
    await vi.waitFor(() => expect(channelFixture.dispatch.mock.calls.some(call => (call[1] as { text?: string }).text?.includes('Summary:'))).toBe(true))
    const sent = channelFixture.dispatch.mock.calls.map(call => call[1] as { type: string; action?: string; text?: string })
    expect(channelFixture.activity.mock.calls[0][1]).toEqual({ type: 'activity', action: 'typing' })
    expect(sent.filter(content => content.type === 'text').map(content => content.text)).toEqual(['I will look up the song and play it.', 'Playing Fern Song. Summary: found it in your library and started playback.'])
    expect(order).toEqual(['typing', 'I will look up the song and play it.'])
  })
  it('sends the same opening line on WhatsApp, with typing bound to the incoming message', async () => {
    const test = createBackendChannelFixture()
    const chat = { ...thread(), id: 'whatsapp-fern', source: 'whatsapp', channelId: 'whatsapp-channel', chatRef: '41790000000' } as AiChatThread
    await test.runtime.repository.data.transaction([{ dataset: 'inbound_receipts', operation: 'upsert', values: record('whatsapp-turn', chat.id, 'ACCEPTED', { id: 'whatsapp-turn', channelId: chat.channelId, chatRef: chat.chatRef, providerMessageId: 'wamid.fern', receivedAt: Date.now() }) }])
    channelFixture.infer.mockImplementationOnce(async (_input, _context, hooks: RuntimeHooks) => {
      hooks.event({ type: 'message', message: { id: 'opening', role: 'assistant', content: '', toolCalls: [{ id: 'list', name: 'command_list', arguments: {} }] } })
      await hooks.tool({ id: 'list', name: 'command_list', arguments: {} })
      hooks.event({ type: 'message', message: { id: 'final', role: 'assistant', content: 'Paused. Summary: playback is paused.' } })
    })
    await test.runtime.submit({ id: 'whatsapp-turn', conversationId: chat.id, text: 'Pause the music', thread: chat })
    await test.runtime.coordinator.waitForTurn(chat.id, 'whatsapp-turn')
    await vi.waitFor(() => expect(channelFixture.dispatch.mock.calls.some(call => (call[1] as { text?: string }).text?.includes('Summary:'))).toBe(true))
    const sent = channelFixture.dispatch.mock.calls.map(call => call[1] as { type: string; messageId?: string; text?: string })
    expect(channelFixture.activity.mock.calls[0][1]).toEqual({ type: 'activity', action: 'typing', messageId: 'wamid.fern' })
    expect(sent.filter(content => content.type === 'text').map(content => content.text)).toEqual(['Working on it.', 'Paused. Summary: playback is paused.'])
  })
  it('opens an in-app turn that goes straight to a tool with the same fallback line', async () => {
    const test = createBackendChannelFixture(), chat = thread()
    channelFixture.infer.mockImplementationOnce(async (_input, _context, hooks: RuntimeHooks) => {
      hooks.event({ type: 'message', message: { id: 'opening', role: 'assistant', content: '', toolCalls: [{ id: 'list', name: 'command_list', arguments: {} }] } })
      await hooks.tool({ id: 'list', name: 'command_list', arguments: {} })
      hooks.event({ type: 'message', message: { id: 'more', role: 'assistant', content: '', toolCalls: [{ id: 'again', name: 'command_list', arguments: {} }] } })
      await hooks.tool({ id: 'again', name: 'command_list', arguments: {} })
      hooks.event({ type: 'message', message: { id: 'final', role: 'assistant', content: 'Paused. Summary: playback is paused.' } })
    })
    await test.runtime.submit({ id: 'app-turn', conversationId: chat.id, text: 'Pause the music', thread: chat })
    await test.runtime.coordinator.waitForTurn(chat.id, 'app-turn')
    const replies = test.runtime.coordinator.snapshot(chat.id)!.thread!.messages.filter(message => message.role === 'assistant')
    expect(replies.map(message => message.content)).toEqual(['Working on it.', '', 'Paused. Summary: playback is paused.'])
  })
})

describe('turn efficiency (readiness 4.9)', () => {
  const describedWrite = (generation: string) => ({ id: 'notes.write', description: 'Write a note', effect: 'write' as const, retry: 'reconcile' as const, available: true, location: 'backend' as const, parameters: { type: 'object' }, owner: { id: 'notes', generation } })
  it('stops a model that keeps calling a tool that does not exist', async () => {
    const test = createBackendChannelFixture(), chat = thread()
    let handled = 0
    channelFixture.infer.mockImplementation(async (_input, _context, hooks: RuntimeHooks) => {
      for (let round = 0; round < 6; round++) { await hooks.tool({ id: `missing-${round}`, name: 'missing_tool', arguments: { round } }); handled++ }
    })
    await test.runtime.submit({ id: 'missing', conversationId: chat.id, text: 'Shuffle my music', thread: chat })
    await expect(test.runtime.coordinator.waitForTurn(chat.id, 'missing')).rejects.toThrow('missing_tool is not available here and was tried 3 times')
    expect(handled).toBe(2)
    expect(test.runtime.coordinator.snapshot(chat.id)).toMatchObject({ state: 'FAILED' })
  })
  it('keeps several corrections of input or conflicts, then stops an endless correction loop', async () => {
    const test = createBackendChannelFixture(), chat = thread()
    vi.mocked(test.api.agent.describe).mockResolvedValue(describedWrite('1'))
    const conflict = () => Object.assign(new Error('Revision changed'), { code: 'REVISION_CONFLICT', outcome: 'not-applied', retryable: false })
    vi.mocked(test.api.agent.invoke).mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict()).mockResolvedValueOnce({ written: true }).mockRejectedValue(conflict())
    channelFixture.infer.mockImplementation(async (_input, _context, hooks: RuntimeHooks) => {
      for (let revision = 1; revision <= 20; revision++) await hooks.tool({ id: `write-${revision}`, name: 'command_execute', arguments: { command: 'notes.write', arguments: { revision } } })
    })
    await test.runtime.submit({ id: 'loop', conversationId: chat.id, text: 'Create the note fern.md', thread: chat })
    await expect(test.runtime.coordinator.waitForTurn(chat.id, 'loop')).rejects.toThrow('still failed after 6 corrections in a row')
    expect(test.api.agent.invoke).toHaveBeenCalledTimes(11)
  })
  it('caches a command schema only for the generation that issued it', async () => {
    const test = createBackendChannelFixture(), chat = thread()
    vi.mocked(test.api.agent.describe).mockResolvedValueOnce(describedWrite('1')).mockResolvedValueOnce(describedWrite('2'))
    vi.mocked(test.api.agent.catalog).mockResolvedValueOnce({ commands: [describedWrite('1')], total: 1 }).mockResolvedValueOnce({ commands: [describedWrite('2')], total: 1 })
    vi.mocked(test.api.agent.invoke).mockResolvedValue({ written: true })
    channelFixture.infer.mockImplementation(async (_input, _context, hooks: RuntimeHooks) => {
      const write = (id: string) => hooks.tool({ id, name: 'command_execute', arguments: { command: 'notes.write', arguments: { text: id } } })
      await write('a'); await hooks.tool({ id: 'list-1', name: 'command_list', arguments: { filter: 'notes' } }); await write('b')
      await hooks.tool({ id: 'list-2', name: 'command_list', arguments: { filter: 'notes.write' } }); await write('c')
    })
    await test.runtime.submit({ id: 'schemas', conversationId: chat.id, text: 'Create the note fern.md', thread: chat })
    await test.runtime.coordinator.waitForTurn(chat.id, 'schemas')
    expect(test.api.agent.describe).toHaveBeenCalledTimes(2)
    expect(test.api.agent.invoke).toHaveBeenCalledTimes(3)
  })
})

