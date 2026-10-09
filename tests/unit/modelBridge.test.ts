import { describe, expect, it, vi } from 'vitest'
import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
import { valleyCancellationOf } from '@valley/plugin-sdk/valleyCancellation'
import type { AiChatRequest, AiStreamEvent } from '../../src/types'
import { bridgeModel } from '../../src/backend/runtimes/model'

function fixture() {
  const controller = new AbortController(), off = vi.fn(), active = new Map<string, string>()
  let receive!: (event: AiStreamEvent) => void
  const complete = vi.fn(async (_request: AiChatRequest) => new Promise<{ text: string; toolCalls: [] }>(() => {}))
  const cancel = vi.fn(async () => new Promise<boolean>(() => {}))
  const context = { cancellation: valleyCancellationOf(controller), api: { ai: { complete, cancel, onStream: (listener: typeof receive) => { receive = listener; return off } } } } as unknown as PluginBackendOperationContext
  const progress = vi.fn(), onText = vi.fn(), send = vi.fn(async () => {})
  const request: AiChatRequest = { requestId: 'fixture-request', provider: 'deepseek', model: 'fixture-model', messages: [{ role: 'user', content: 'Read the note fern.md' }], tools: [] }
  const start = () => bridgeModel({ params: { id: 'native-1', model: request.model, messages: request.messages }, request, context, active, send, onText, onProgress: progress })
  return { controller, off, active, complete, cancel, progress, onText, send, start, emit: (event: Omit<AiStreamEvent, 'requestId'>) => receive({ requestId: complete.mock.calls[0][0].requestId!, ...event } as AiStreamEvent) }
}

describe('native provider cancellation and progress', () => {
  it('settles when completion and provider cancellation both remain pending', async () => {
    const test = fixture(), running = test.start()
    const rejected = expect(running).rejects.toThrow('Model request cancelled')
    expect(test.complete).toHaveBeenCalledOnce()
    test.controller.abort()
    await rejected
    expect(test.off).toHaveBeenCalled()
    expect(test.cancel).toHaveBeenCalledOnce()
    expect(test.active.size).toBe(0)
    expect(test.send).not.toHaveBeenCalled()
  })
  it('counts content and tool decisions, not usage or empty text, as progress', async () => {
    const test = fixture(), running = test.start()
    const rejected = expect(running).rejects.toThrow('Model request cancelled')
    test.emit({ type: 'usage' })
    test.emit({ type: 'text', text: '' } as Omit<AiStreamEvent, 'requestId'>)
    await Promise.resolve(); await Promise.resolve()
    expect(test.progress).not.toHaveBeenCalled()
    test.emit({ type: 'text', text: 'Reading the note' } as Omit<AiStreamEvent, 'requestId'>)
    await vi.waitFor(() => expect(test.progress).toHaveBeenCalledOnce())
    test.controller.abort()
    await rejected
    expect(test.complete).toHaveBeenCalledOnce()
  })
})
