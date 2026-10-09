import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiChatThread } from '../src/types'
import type { RuntimeHooks } from '../src/backend/runtimes'
import { createBackendChannelFixture, channelFixture } from './backendChannelFixture'
import { scheduleChatNaming } from '../src/backend/chatNaming'
import { admitTurn } from '../src/backend/engine/responsiveness'
import * as threads from '../src/backend/threads'

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
    expect(JSON.parse(test.runtime.coordinator.snapshot(chat.id)!.thread!.messages.at(-1)!.content)).toMatchObject({ success: false, error: { code: 'UNKNOWN_PREVIOUS_OUTCOME' } })
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
    await expect(test.runtime.coordinator.waitForTurn(chat.id, 'first')).rejects.toThrow('TARGET_REQUIRED')
    expect(continued).not.toHaveBeenCalled()
    expect(test.api.agent.invoke).toHaveBeenCalledOnce()
    const session = test.runtime.coordinator.snapshot(chat.id)!
    expect(session).toMatchObject({ state: 'FAILED', streamingText: '', paused: true })
    expect(JSON.parse(session.thread!.messages.at(-1)!.content)).toMatchObject({ success: false, error: { code: 'TARGET_REQUIRED', recoverable: false } })
    expect((await test.runtime.repository.rows('tool_executions'))[0]).toMatchObject({ state: outcome === 'unknown' ? 'UNKNOWN' : 'COMPLETED' })
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
})
