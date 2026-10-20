import { assertChatWritable } from './attachments'
import { z } from 'zod'
import { redactSecrets, type PluginBackendOperationContext } from '@valley/plugin-sdk'
import type { PluginProcessEvent, ProjectActivity } from '@valley/plugin-sdk/pluginExecution'
import { executionContext, executionFile } from './projects'
import { activityRequest, appendActivity, outputChunks } from './activity'
import { chatStopping, runtimeScope, trackProcessScope } from './processScopes'
export { runtimeScope, stopChatProcesses, stopProjectProcesses } from './processScopes'
export async function executeProjectCommand(payload: unknown, context: PluginBackendOperationContext): Promise<{ text: string }> {
  // Invalid input (such as a missing working directory) is rejected before anything starts, so the model can correct it.
  const parsed = z.object({ chatId: z.string().min(1).max(256), command: z.string().min(1).max(32000), rootId: z.string().uuid(), path: z.string().max(4096).default(''), network: z.boolean().default(false), activity: z.object({ runId: z.string(), callId: z.string() }).optional() }).strict().safeParse(payload)
  if (!parsed.success) throw Object.assign(new Error(`The terminal command was not started: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'input'} ${issue.message.toLowerCase()}`).join('; ')}.${parsed.error.issues.some(issue => issue.path[0] === 'rootId') ? ' No working directory is available in this conversation; use the vault file commands instead.' : ''}`), { code: 'INVALID_INPUT', outcome: 'not-applied' })
  const input = parsed.data
  const access = await executionContext(input.chatId, context.api), roots = access.roots
  const cwd = executionFile(access, input.rootId, input.path)
  const id = crypto.randomUUID(), scopeId = runtimeScope(input.chatId), api = context.api
  let stopped = false
  const release = trackProcessScope(input.chatId, () => { stopped = true; void api.process.cancel(id).catch(() => {}) })
  const activity: ProjectActivity = { runId: input.activity?.runId ?? context.id, callId: id, parentCallId: input.activity?.callId, name: 'command', state: 'running', timestamp: Date.now(), arguments: { command: input.command, workingDirectory: access.root.path + '/' + cwd.path, network: input.network } }
  let chain = Promise.resolve(), outputRef: string | undefined, preview = '', failure: unknown
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() }
  const buffers = { stdout: '', stderr: '' }
  const persist = async (stream: 'stdout' | 'stderr', text: string): Promise<void> => {
    const redacted = `[${stream}] ${redactSecrets(text)}`
    preview = (preview + redacted).slice(-16000)
    for (const chunk of outputChunks(redacted)) outputRef = await activityRequest('output', { chatId: input.chatId, runId: activity.runId, callId: id, text: chunk, first: !outputRef }) as string
    await appendActivity(input.chatId, { ...activity, timestamp: Date.now(), outputRef })
  }
  const observe = async (event: PluginProcessEvent): Promise<void> => {
    if (event.type !== 'output' || event.id !== id) return
    buffers[event.stream] += decoders[event.stream].decode(Uint8Array.from(atob(event.base64), char => char.charCodeAt(0)), { stream: true })
    const end = buffers[event.stream].lastIndexOf('\n') + 1
    if (end) { const line = buffers[event.stream].slice(0, end); buffers[event.stream] = buffers[event.stream].slice(end); await persist(event.stream, line) }
    if (buffers[event.stream].length > 1048576) throw new Error('Command emitted an unterminated output line larger than 1 MB')
  }
  const off = api.process.onEvent(event => {
    if (event.type === 'exit' || event.id !== id) return
    if (event.type === 'state') { chain = chain.then(() => appendActivity(input.chatId, { ...activity, state: event.state, timestamp: event.timestamp, outputRef })).catch(error => { failure ??= error; void api.process.cancel(id).catch(() => {}) }); return }
    chain = chain.then(() => observe(event)).catch(error => { failure ??= error; void api.process.cancel(id).catch(() => {}) })
  })
  try {
    await assertChatWritable(input.chatId)
    await appendActivity(input.chatId, activity)
    if (stopped || context.cancellation.aborted || chatStopping(input.chatId)) throw Object.assign(new Error('The conversation was stopped before this command started'), { code: 'COMMAND_CANCELLED', outcome: 'not-applied', retryable: false })
    await api.process.start({ id, scopeId, projectId: access.root.projectId, rootIds: roots.map(root => root.id), cwd, command: input.command, network: input.network, timeoutMs: 300000 })
    const result = await api.process.wait(id)
    await chain
    for (const stream of ['stdout', 'stderr'] as const) {
      const text = buffers[stream] + decoders[stream].decode()
      if (text) await persist(stream, text)
    }
    if (failure) throw failure
    await appendActivity(input.chatId, { ...activity, timestamp: Date.now(), outputRef, state: result.cancelled ? 'cancelled' : result.exitCode !== 0 || result.error ? 'failed' : 'completed', result })
    return { text: `${result.cancelled || result.exitCode !== 0 || result.error ? 'Error: ' : ''}${JSON.stringify(result)}\n${preview}` }
  } catch (error) {
    await api.process.cancel(id).catch(() => {})
    await chain
    await appendActivity(input.chatId, { ...activity, timestamp: Date.now(), outputRef, state: context.cancellation.aborted || stopped || chatStopping(input.chatId) ? 'cancelled' : 'failed', result: { error: error instanceof Error ? error.message : String(error) } })
    throw error
  } finally {
    off(); release()
    // The host keeps every unfinished streaming decoder, so a failed command finishes them too.
    decoders.stdout.decode(); decoders.stderr.decode()
  }
}
