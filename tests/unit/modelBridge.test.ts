import { describe, expect, it, vi } from 'vitest'
import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
import { valleyCancellationOf } from '@valley/plugin-sdk/valleyCancellation'
import type { AiChatRequest, AiStreamEvent } from '../../src/types'
import { bridgeModel, recoverInterruptedTools } from '../../src/backend/runtimes/model'

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

describe('provider history', () => {
  it('keeps a tool result right after its call when the tool saved a message while running', () => {
    const history = recoverInterruptedTools([
      { role: 'user', content: 'Open my smoke note.' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'ask', name: 'ask_user', arguments: {} }] },
      { role: 'assistant', content: 'Which one should I open?' },
      { role: 'tool', toolCallId: 'ask', name: 'ask_user', content: 'Question saved.' },
      { role: 'user', content: 'The first one' }
    ])
    expect(history.map(message => message.role === 'tool' ? `tool:${message.content}` : `${message.role}:${message.content}`)).toEqual(['user:Open my smoke note.', 'assistant:', 'tool:Question saved.', 'assistant:Which one should I open?', 'user:The first one'])
  })

  it('still closes a call whose result never arrived', () => {
    const history = recoverInterruptedTools([
      { role: 'assistant', content: '', toolCalls: [{ id: 'lost', name: 'command_execute', arguments: {} }] },
      { role: 'assistant', content: 'Saved while running' },
      { role: 'user', content: 'Next' }
    ])
    expect(history.map(message => message.role)).toEqual(['assistant', 'tool', 'assistant', 'user'])
    expect(history[1]).toMatchObject({ toolCallId: 'lost', content: expect.stringContaining('interrupted') })
  })
})
