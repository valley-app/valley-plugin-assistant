import { z } from 'zod'
import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
import type { AiChatRequest, AiMessage, AiToolCall } from '../../types'
import { runtimeScope, trackProcessScope } from '../processScopes'
import { appendActivity, activityRequest, outputChunks } from '../activity'
import { assertChatWritable } from '../attachments'
import { redactSecrets } from '@valley/plugin-sdk'
import { object, deepseekMessage, bridgeModel } from './model'
const replies = new Map<string, { runId: string; nativeId: string; resolve(value: string): void }>()
const steering = new Set<string>()
export function steerRuntime(value: unknown): void {
  const { runId } = z.object({ runId: z.string().uuid() }).strict().parse(value)
  if (steering.size < 64) steering.add(runId)
}
export function respondToRuntime(value: unknown): void {
  const input = z.object({ runId: z.string().uuid(), id: z.string(), text: z.string().max(100000) }).strict().parse(value)
  const reply = replies.get(input.id)
  if (!reply || reply.runId !== input.runId) throw new Error('Tool request has expired')
  replies.delete(input.id); reply.resolve(input.text)
}
export interface RuntimeHooks {
  event(payload: Record<string, unknown>): void
  tool(call: AiToolCall): Promise<string>
  prepare?(request: AiChatRequest): Promise<AiChatRequest>
}
export async function runNativeRuntime(value: unknown, context: PluginBackendOperationContext, hooks?: RuntimeHooks): Promise<void> {
  const input = z.object({ runId: z.string().uuid(), harness: z.literal('deepseek'), chatId: z.string().min(1).max(256), request: z.record(z.unknown()) }).strict().parse(value)
  const request = input.request as unknown as AiChatRequest
  if (typeof request.model !== 'string' || !Array.isArray(request.messages) || !Array.isArray(request.tools)) throw new Error('Invalid runtime request')
  const api = context.api, id = crypto.randomUUID(), scopeId = runtimeScope(input.chatId)
  const availability = await api.process.available()
  if (!availability.runtimes.includes(input.harness)) throw new Error('The bundled DeepSeek native harness is unavailable on this platform or in this build')
  const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>()
  const models = new Map<string, string>()
  const continuations = new Map<number, AiMessage['continuation']>()
  let assistantMessages = 0
  let counter = 0, buffer = '', serial = Promise.resolve(), failure: unknown, running = false, stopping = false, completed = false, cancelled = false
  const decoder = new TextDecoder(), stderrDecoder = new TextDecoder()
  const tasks = new Set<Promise<void>>()
  let stderr = '', diagnostic = Promise.resolve(), outputRef: string | undefined
  const activity = { runId: input.runId, callId: id, name: input.harness, state: 'running' as const, timestamp: Date.now(), arguments: { model: request.model } }
  const persistDiagnostic = async (text: string) => {
    const redacted = redactSecrets(text)
    for (const chunk of outputChunks(redacted)) outputRef = await activityRequest('output', { chatId: input.chatId, runId: input.runId, callId: id, text: chunk, first: !outputRef }) as string
    await appendActivity(input.chatId, { ...activity, timestamp: Date.now(), outputRef })
  }
  let done!: () => void, fail!: (error: Error) => void
  const finished = new Promise<void>((resolve, reject) => { done = () => { completed = true; resolve() }; fail = reject })
  void finished.catch(() => {})
  const emit = (payload: Record<string, unknown>) => hooks ? hooks.event(payload) : api.rpc.emit('harness.event', { runId: input.runId, ...payload })
  let writing = Promise.resolve()
  const send = (value: unknown): Promise<void> => {
    const frame = JSON.stringify(value) + '\n'
    if (frame.length > 4 * 1024 * 1024) return Promise.reject(new Error('Runtime frame exceeds 4 MB'))
    writing = writing.then(async () => {
      for (let offset = 0; offset < frame.length;) {
        let end = Math.min(offset + 64000, frame.length)
        if (end < frame.length && /[\uD800-\uDBFF]/.test(frame[end - 1])) end--
        await api.process.input(id, frame.slice(offset, end)); offset = end
      }
    })
    return writing
  }
  const invoke = (method: string, params: unknown): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const number = ++counter
    const timer = setTimeout(() => { pending.delete(number); reject(new Error(`Runtime did not answer ${method} within 30 seconds`)) }, 30000)
    pending.set(number, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    void send({ jsonrpc: '2.0', id: number, method, params }).catch(error => { pending.delete(number); clearTimeout(timer); reject(error) })
  })
  const message = (message: AiMessage) => {
    if (message.role === 'assistant') message.continuation = continuations.get(assistantMessages++)
    emit({ type: 'message', message: { ...message, ts: message.ts ?? Date.now(), activityRunId: input.runId } })
  }
  const model = async (params: Record<string, unknown>) => bridgeModel({ params, request, context, active: models, continuations, send, prepare: hooks?.prepare, onText: text => emit({ type: 'text', text }) })
  const toolWork = new Set<Promise<string>>()
  const tool = async (params: Record<string, unknown>): Promise<string> => {
    if (steering.has(input.runId)) return 'Skipped because the conversation was redirected.'
    const requestId = crypto.randomUUID()
    const call: AiToolCall = { id: String(params.callId ?? params.id ?? requestId), name: String(params.name ?? params.tool), arguments: object(params.arguments) }
    const result = hooks ? hooks.tool(call) : new Promise<string>(resolve => { replies.set(requestId, { runId: input.runId, nativeId: String(params.id ?? params.callId), resolve }) })
    toolWork.add(result)
    emit({ type: 'tool', id: requestId, call })
    try { return await result } finally { toolWork.delete(result) }
  }
  const receive = async (frame: Record<string, unknown>): Promise<void> => {
    if (typeof frame.id === 'number' && pending.has(frame.id) && !frame.method) {
      const awaiting = pending.get(frame.id)!; pending.delete(frame.id)
      if (frame.error) awaiting.reject(new Error(String(object(frame.error).message ?? JSON.stringify(frame.error))))
      else awaiting.resolve(object(frame.result))
      return
    }
    const params = object(frame.params), method = String(frame.method)
    if (method === 'valley/tool/cancel') {
      for (const [id, reply] of replies) if (reply.runId === input.runId && reply.nativeId === String(params.id)) {
        replies.delete(id); emit({ type: 'tool-cancelled', id }); reply.resolve('Error: Tool cancelled')
      }
      return
    }
    if (method === 'valley/ai/cancel') { const requestId = models.get(String(params.id)); if (requestId) await api.ai.cancel(requestId); return }
    if (method === 'valley/ai/request') {
      if (steering.has(input.runId)) {
        await Promise.allSettled([...toolWork])
        done()
        return
      }
      try { await model(params); await send({ jsonrpc: '2.0', id: frame.id, result: {} }) }
      catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        await send({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: text } })
        throw new Error(redactSecrets(text))
      }
    } else if (method === 'valley/tool/call') await send({ jsonrpc: '2.0', id: frame.id, result: await tool(params) })
    else if (method === 'session.event') {
      const event = object(params.event), data = object(event.data)
      if (event.type === 'assistant/message' || event.type === 'tool/result') message(deepseekMessage(data.message))
      if (event.type === 'turn/end' && object(data.reason).kind !== 'completed') throw new Error(`DeepSeek turn ended: ${String(object(data.reason).kind)}`)
    } else if (method === 'session.status') {
      if (params.status === 'running') running = true
      if (params.status === 'idle' && running) done()
    } else if (frame.id !== undefined) await send({ id: frame.id, error: { code: -32601, message: 'This runtime capability is not exposed by Valley. Use the supplied tools.' } })
  }
  const stop = (error: Error) => {
    failure ??= error
    for (const waiting of pending.values()) waiting.reject(error)
    pending.clear()
    for (const [key, reply] of replies) if (reply.runId === input.runId) { replies.delete(key); reply.resolve('Error: Conversation cancelled') }
    for (const requestId of models.values()) void api.ai.cancel(requestId).catch(() => {})
    void api.process.cancel(id).catch(() => {})
    fail(error)
  }
  const abort = () => { cancelled = true; stop(new Error('Runtime cancelled')) }
  const track = (task: Promise<void>) => {
    tasks.add(task)
    void task.then(() => tasks.delete(task), error => { tasks.delete(task); stop(error instanceof Error ? error : new Error(String(error))) })
  }
  const release = trackProcessScope(input.chatId, abort)
  const timer = setTimeout(() => stop(new Error('Runtime turn exceeded 15 minutes')), 900000)
  context.cancellation.addEventListener('abort', abort, { once: true })
  const off = api.process.onEvent(event => {
    if (event.type === 'exit' && event.result.id === id) {
      void serial.then(() => {
        if (!stopping && !completed) stop(new Error(event.result.error ?? `Runtime exited (${event.result.exitCode ?? event.result.signal})`))
      })
    } else if (event.type === 'output' && event.id === id) {
      const bytes = Uint8Array.from(atob(event.base64), char => char.charCodeAt(0))
      if (event.stream === 'stderr') {
        stderr += stderrDecoder.decode(bytes, { stream: true })
        const end = stderr.lastIndexOf('\n') + 1
        if (end) {
          const text = stderr.slice(0, end); stderr = stderr.slice(end)
          diagnostic = diagnostic.then(() => persistDiagnostic(text)).catch(error => stop(error))
        }
        if (stderr.length > 1048576) stop(new Error('Runtime diagnostic line exceeds 1 MB'))
        return
      }
      buffer += decoder.decode(bytes, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (line.length > 4 * 1024 * 1024) { stop(new Error('Runtime protocol frame exceeds 4 MB')); return }
        serial = serial.then(async () => {
          if (stopping || !line.trim()) return
          const frame = object(JSON.parse(line))
          if (['valley/ai/request', 'valley/tool/call', 'item/tool/call'].includes(String(frame.method))) track(receive(frame))
          else await receive(frame)
        }).catch(error => stop(error))
      }
      if (buffer.length > 4 * 1024 * 1024) stop(new Error('Runtime protocol frame exceeds 4 MB'))
    }
  })
  try {
    if (context.cancellation.aborted) throw new Error('Runtime cancelled')
    await assertChatWritable(input.chatId)
    await appendActivity(input.chatId, activity)
    const started = await api.process.start({ id, scopeId, rootIds: [], runtime: 'deepseek', environment: {}, timeoutMs: 900000, args: [] })
    const systemPrompt = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
    const latest = [...request.messages].reverse().find(message => message.role === 'user')?.content ?? ''
    await invoke('valley/configure', { systemPrompt, tools: request.tools })
    await invoke('initialize', { cwd: started.home, provider: 'valley', model: request.model, maxTokens: request.maxTokens })
    await invoke('session/prompt', { sessionId: input.runId, contentBlocks: [{ type: 'text', text: latest }] })
    await finished
    if (failure) throw failure
  } catch (error) {
    failure ??= error
    throw error
  } finally {
    stopping = true
    clearTimeout(timer)
    context.cancellation.removeEventListener('abort', abort)
    steering.delete(input.runId)
    for (const [id, reply] of replies) if (reply.runId === input.runId) { replies.delete(id); reply.resolve('Error: Runtime stopped') }
    await Promise.allSettled([...models.values()].map(id => api.ai.cancel(id)))
    await api.process.cancel(id).catch(() => {})
    await serial
    await Promise.allSettled([...tasks])
    await diagnostic
    try {
      const tail = stderr + stderrDecoder.decode()
      if (tail) await persistDiagnostic(tail)
    } finally { off(); release() }
    await appendActivity(input.chatId, { ...activity, timestamp: Date.now(), outputRef, state: failure ? cancelled || context.cancellation.aborted ? 'cancelled' : 'failed' : 'completed', result: failure ? { error: String(failure) } : { completed: true } })
  }
}
