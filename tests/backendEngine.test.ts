// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { datasetFixture } from './backendDatasetFixture'
import { initBackend } from '../src/backend/runtime'
import { startRun, cancelRun, cancelAllRuns, cancelChatRuns, runDetailed, relayAiStream } from '../src/backend/engine'
const request = { requestId: 'one', provider: 'openai', connectionId: 'work', model: 'chosen-model', messages: [], conversationId: 'chat-one' }
const ai = { stream: vi.fn(), complete: vi.fn(), cancel: vi.fn(async () => true) }
const emit = vi.fn()
const api = { data: datasetFixture(), ai, process: { shutdown: vi.fn(async () => {}) }, rpc: { emit } } as unknown as PluginBackendApi
beforeEach(() => { vi.resetAllMocks(); ai.stream.mockResolvedValue(undefined); ai.cancel.mockResolvedValue(true); initBackend(api) })
afterEach(async () => { await cancelAllRuns() })
describe('Assistant shared AI client', () => {
  it('forwards the exact connection and model and relays only its own active stream', async () => {
    await startRun('/vault', request)
    expect(ai.stream).toHaveBeenCalledWith(request)
    relayAiStream(api, { requestId: 'another', type: 'text', text: 'unrelated' })
    relayAiStream(api, { requestId: 'one', type: 'text', text: 'Grüße' })
    relayAiStream(api, { requestId: 'one', type: 'done' })
    relayAiStream(api, { requestId: 'one', type: 'text', text: 'late' })
    expect(emit.mock.calls).toEqual([['stream', { requestId: 'one', type: 'text', text: 'Grüße' }], ['stream', { requestId: 'one', type: 'done' }]])
    expect(await cancelRun('one')).toBe(false)
  })
  it('rejects duplicate IDs and drains cancellation before completing deletion', async () => {
    let finish!: (value: boolean) => void
    ai.cancel.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await startRun('/vault', request)
    await expect(startRun('/vault', request)).rejects.toThrow('already running')
    let deleted = false
    const stopping = cancelChatRuns('chat-one').then(() => { deleted = true })
    await Promise.resolve()
    expect(deleted).toBe(false)
    finish(true); await stopping
    expect(await cancelRun('one')).toBe(false)
  })
  it('does not cancel conversations outside the deleted chat', async () => {
    await startRun('/vault', request)
    await startRun('/vault', { ...request, requestId: 'two', conversationId: 'chat-two' })
    await cancelChatRuns('chat-one')
    expect(ai.cancel.mock.calls).toEqual([['one']])
  })
  it('keeps old streams and cancellations on their captured backend', async () => {
    await startRun('/vault', request)
    const replacement = { ai: { cancel: vi.fn() }, rpc: { emit: vi.fn() } } as unknown as PluginBackendApi
    initBackend(replacement)
    relayAiStream(replacement, { requestId: 'one', type: 'text', text: 'wrong owner' })
    await cancelRun('one')
    expect(replacement.rpc.emit).not.toHaveBeenCalled()
    expect(replacement.ai.cancel).not.toHaveBeenCalled()
    expect(ai.cancel).toHaveBeenCalledWith('one')
  })
  it('settles rejected starts with a visible error and terminal event', async () => {
    ai.stream.mockRejectedValue(new Error('Permission denied'))
    await startRun('/vault', request)
    expect(emit.mock.calls).toEqual([
      ['stream', { requestId: 'one', type: 'error', error: 'Permission denied' }],
      ['stream', { requestId: 'one', type: 'done', finishReason: 'error' }]
    ])
  })
  it('preserves complete tool results and detailed usage supplied by core', async () => {
    const result = { text: '', toolCalls: [{ id: 'call', name: 'read', arguments: { path: 'example.ts' } }], inputTokens: 10, outputTokens: 4, connectionId: 'work', events: [], latencyMs: 10 }
    ai.complete.mockResolvedValue(result)
    expect(await runDetailed('/vault', request)).toEqual(result)
    expect(ai.complete).toHaveBeenCalledWith(request)
  })
  it('forwards cancellation of a detailed completion and waits for the cancel acknowledgement', async () => {
    let finish!: (value: unknown) => void
    ai.complete.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const controller = new AbortController()
    const running = runDetailed('/vault', request, controller)
    await vi.waitFor(() => expect(ai.complete).toHaveBeenCalledOnce())
    controller.abort()
    expect(ai.cancel).toHaveBeenCalledWith('one')
    finish({ text: '' }); await running
  })
})
