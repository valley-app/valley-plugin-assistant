import { valleyCancellationOf, type ValleyCancellation } from '@valley/plugin-sdk/valleyCancellation'
import type { AiChatRequest, AiMessage, AiToolCall } from '../types'
import type { RunAgentOptions } from './loop'
export async function runNativeHarness(options: RunAgentOptions, request: AiChatRequest, runId: string, runTool: (call: AiToolCall, cancellation: ValleyCancellation) => Promise<string>): Promise<void> {
  const { api } = options
  const running = new Set<Promise<unknown>>()
  let failure: unknown
  const controller = new AbortController()
  const toolControllers = new Map<string, AbortController>()
  const abort = () => controller.abort()
  options.cancellation?.addEventListener('abort', abort, { once: true })
  if (options.cancellation?.aborted) abort()
  const off = api.backend.on('harness.event', value => {
    const event = value as { runId: string; type: string; text?: string; message?: AiMessage; id?: string; call?: AiToolCall }
    if (event.runId !== runId) return
    if (event.type === 'text') options.onText(event.text ?? '')
    else if (event.type === 'message' && event.message) options.onMessage(event.message)
    else if (event.type === 'tool-cancelled' && event.id) toolControllers.get(event.id)?.abort()
    else if (event.type === 'tool' && event.id && event.call) {
      const toolController = new AbortController(), cancelTool = () => toolController.abort()
      toolControllers.set(event.id, toolController)
      controller.signal.addEventListener('abort', cancelTool, { once: true })
      if (controller.signal.aborted) cancelTool()
      const task = (async () => {
        try {
        let text: string
        try { text = await runTool(event.call!, valleyCancellationOf(toolController)) } catch (error) { text = `Error: ${String(error)}` }
        if (!toolController.signal.aborted) await api.backend.call('harness.respond', { runId, id: event.id, text })
        } finally { controller.signal.removeEventListener('abort', cancelTool); toolControllers.delete(event.id!) }
      })()
      running.add(task)
      void task.then(() => running.delete(task), error => { failure ??= error; controller.abort(); running.delete(task) })
    }
  })
  try {
    await api.backend.callOperation('harness.run', { runId, harness: options.harness, chatId: options.conversationId, request }, { cancellation: valleyCancellationOf(controller) })
    await Promise.allSettled([...running])
    if (failure) throw failure
  } finally { controller.abort(); options.cancellation?.removeEventListener('abort', abort); off(); await Promise.allSettled([...running]) }
}
