import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
import type { AiChatRequest, AiMessage, AiStreamEvent, AiToolCall } from '../../types'
export const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const text = (value: unknown): string => typeof value === 'string' ? value : ''
function recoverInterruptedTools(messages: AiMessage[]): AiMessage[] {
  const history: AiMessage[] = [], pending = new Map<string, AiToolCall>()
  const flush = () => {
    for (const call of pending.values()) history.push({ role: 'tool', toolCallId: call.id, name: call.name, content: 'This tool execution was interrupted. Its outcome is unknown; check the current state before retrying.' })
    pending.clear()
  }
  for (const message of messages) {
    if (message.role !== 'tool') flush()
    history.push(message)
    if (message.role === 'tool' && message.toolCallId) pending.delete(message.toolCallId)
    for (const call of message.toolCalls ?? []) pending.set(call.id, call)
  }
  flush()
  return history
}
export function deepseekMessage(value: unknown): AiMessage {
  const message = object(value), blocks = list(message.content).map(object)
  const toolCalls = blocks.filter(block => block.type === 'tool-call').map(block => ({ id: text(block.id), name: text(block.name), arguments: object(JSON.parse(text(block.arguments) || '{}')) }))
  const role = ['user', 'assistant', 'tool', 'system'].includes(text(message.role)) ? message.role as AiMessage['role'] : 'system'
  return { role, content: typeof message.content === 'string' ? message.content : blocks.filter(block => block.type === 'text').map(block => text(block.text)).join('\n'), ...(toolCalls.length ? { toolCalls } : {}), ...(message.toolCallId ? { toolCallId: text(message.toolCallId) } : {}) }
}
export async function bridgeModel(input: { params: Record<string, unknown>; request: AiChatRequest; context: PluginBackendOperationContext; send(value: unknown): Promise<void>; onText(text: string): void; active: Map<string, string>; continuations?: Map<number, AiMessage['continuation']>; prepare?(request: AiChatRequest): Promise<AiChatRequest> }): Promise<void> {
  const { params, request, context, send } = input
  const body = params
  if (body.model !== request.model) throw new Error('Runtime requested a different model')
  let id = crypto.randomUUID()
  const nativeId = String(params.id)
  const messages = list(body.messages).map(deepseekMessage)
  let assistantIndex = 0
  for (const message of messages) if (message.role === 'assistant') message.continuation = input.continuations?.get(assistantIndex++)
  const system = request.messages.find(message => message.role === 'system')
  const history = recoverInterruptedTools(request.messages.filter(message => message.role !== 'system').slice(0, -1))
  const latest = [...request.messages].reverse().find(message => message.role === 'user')
  const firstUser = messages.find(message => message.role === 'user')
  if (firstUser && latest?.attachments) firstUser.attachments = latest.attachments
  const selectedTools = new Map((request.tools ?? []).map(tool => [tool.name, tool]))
  const tools = list(body.tools).flatMap(value => { const row = object(value); const name = text(row.name); const tool = selectedTools.get(name); return tool ? [{ name: tool.name, description: tool.description, parameters: tool.parameters }] : [] })
  input.active.set(nativeId, id)
  let index = 0, textIndex = -1, content = '', chain = Promise.resolve(), failure: unknown
  const emittedCalls = new Set<string>()
  const chunk = (chunk: unknown) => send({ jsonrpc: '2.0', method: 'valley/ai/chunk', params: { id: params.id, chunk } })
  const dispatch = async (event: AiStreamEvent): Promise<void> => {
    if (event.type === 'text') {
      if (textIndex < 0) {
        textIndex = index++
        await chunk({ type: 'block-start', index: textIndex, blockType: 'text' })
      }
      content += event.text; input.onText(content)
      await chunk({ type: 'text-delta', index: textIndex, text: event.text })
    } else if (event.type === 'tool_call') {
      if (emittedCalls.has(event.call.id)) return
      emittedCalls.add(event.call.id)
      const call: AiToolCall = event.call, position = index++, argumentsText = JSON.stringify(call.arguments)
      await chunk({ type: 'block-start', index: position, blockType: 'tool-call' })
      await chunk({ type: 'tool-call-delta', index: position, id: call.id, name: call.name, argumentsDelta: argumentsText })
      await chunk({ type: 'block-end', index: position, block: { type: 'tool-call', id: call.id, name: call.name, arguments: argumentsText } })
    } else if (event.type === 'error') throw new Error(event.error)
  }
  const off = context.api.ai.onStream(event => { if (event.requestId === id) chain = chain.then(() => dispatch(event)).catch(error => { failure ??= error; void context.api.ai.cancel(id).catch(() => {}) }) })
  try {
    const assembled: AiChatRequest = { ...request, requestId: id, messages: [...(system ? [system] : []), ...history, ...messages.filter(message => message.role !== 'system')], tools }
    const prepared = input.prepare ? await input.prepare(assembled) : assembled
    let completion = await context.api.ai.complete({ ...prepared, origin: request.origin ?? 'harness', operation: `deepseek.${text(body.purpose) || 'chat'}` })
    await chain
    if (failure) throw failure
    if (!content.trim() && !emittedCalls.size && !completion.text.trim() && !completion.toolCalls.length) {
      context.cancellation.throwIfAborted()
      id = crypto.randomUUID()
      input.active.set(nativeId, id)
      completion = await context.api.ai.complete({ ...prepared, requestId: id, origin: request.origin ?? 'harness', operation: `deepseek.${text(body.purpose) || 'chat'}` })
      await chain
      if (failure) throw failure
    }
    input.continuations?.set(assistantIndex, completion.continuation)
    if (completion.text.startsWith(content) && completion.text.length > content.length) await dispatch({ requestId: id, type: 'text', text: completion.text.slice(content.length) })
    for (const call of completion.toolCalls) await dispatch({ requestId: id, type: 'tool_call', call })
    if (!content.trim() && !completion.toolCalls.length) throw new Error(`The model returned an empty response after retrying (finish: ${completion.finishReason ?? 'unknown'}). Try sending the message again.`)
    if (textIndex >= 0) await chunk({ type: 'block-end', index: textIndex, block: { type: 'text', text: content } })
    await chunk({ type: 'usage', usage: { inputTokens: completion.inputTokens ?? 0, outputTokens: completion.outputTokens ?? 0 } })
    await chunk({ type: 'finish', reason: { kind: completion.toolCalls.length ? 'tool-calls' : 'stop' } })
  } finally { off(); input.active.delete(nativeId); await context.api.ai.cancel(id) }
}
