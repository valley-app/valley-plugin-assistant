import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server'

const transport = new JsonRpcLineTransport(process.stdin, process.stdout)
const ctx = new Context()
const streams = new Map<string, { chunks: StreamChunk[]; wake(): void; closed: boolean }>()
let configured = false
let server: HarnessSdkJsonRpcServer | undefined
let stopping: Promise<void> | undefined
class ValleyAdapter extends LlmAdapter {
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const id = randomUUID()
    const state = { chunks: [] as StreamChunk[], wake: () => {}, closed: false }
    streams.set(id, state)
    const abort = () => transport.notify('valley/ai/cancel', { id })
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    const complete = transport.request('valley/ai/request', { id, ...options, signal: undefined }).then(() => { state.closed = true; state.wake() }, error => {
      state.chunks.push({ type: 'finish', reason: { kind: 'error', failure: { message: String(error), code: 'VALLEY_AI' } } }); state.closed = true; state.wake()
    })
    try {
      while (!state.closed || state.chunks.length) {
        if (state.chunks.length) yield state.chunks.shift()!
        else await new Promise<void>(resolve => { state.wake = resolve })
      }
      await complete
    } finally {
      options.signal?.removeEventListener('abort', abort)
      streams.delete(id)
      if (!state.closed) { abort(); await complete }
    }
  }
}
transport.onNotification((method, params) => {
  if (method !== 'valley/ai/chunk') return
  const state = streams.get(String(params.id))
  if (!state) return
  if (state.chunks.length > 4096) { transport.notify('valley/ai/cancel', { id: params.id }); state.closed = true; state.wake(); return }
  state.chunks.push(params.chunk as StreamChunk); state.wake()
})
async function stop(): Promise<void> {
  stopping ??= (async () => { await server?.shutdown(); await ctx.root.fiber.dispose(); await transport.flush(); transport.close() })()
  return stopping
}
transport.onRequest(async (method, params) => {
  if (method === 'valley/configure') {
    if (configured) throw new Error('Runtime is already configured')
    configured = true
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: String(params.systemPrompt ?? '') })
    await ctx.plugin(Tools)
    await ctx.plugin(AgentRegistry)
    ctx.llm.registerAdapter(['valley'], new ValleyAdapter())
    const tools = params.tools as Array<{ name: string; description: string; parameters: Record<string, unknown> }>
    for (const tool of tools) ctx.tools.register({ ...tool, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }, execute: async (args, execution) => {
      const id = randomUUID()
      const abort = () => transport.notify('valley/tool/cancel', { id })
      execution.signal?.addEventListener('abort', abort, { once: true })
      try { return await transport.request('valley/tool/call', { id, callId: execution.callId, parentCallId: execution.rootCallId, name: tool.name, arguments: args }) }
      finally { execution.signal?.removeEventListener('abort', abort) }
    } })
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
    server = new HarnessSdkJsonRpcServer(ctx, transport)
    return { configured: true }
  }
  if (!server) throw new Error('Configure the runtime first')
  const result = await server.handleRequest(method, params)
  if (method === 'shutdown') setImmediate(() => { void stop().then(() => process.exit(0), () => process.exit(1)) })
  return result
})
transport.start()
process.stdin.once('end', () => { void stop().then(() => process.exit(0), () => process.exit(1)) })
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop().then(() => process.exit(0), () => process.exit(1)) })
