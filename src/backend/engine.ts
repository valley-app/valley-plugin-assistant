import { assertChatWritable } from './attachments'
import { stopChatProcesses } from './processScopes'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import type { AiChatRequest, AiStreamEvent } from '../types'
import type { AiCompletion } from '@valley/plugin-sdk/ai'
import { backendApi, withBackgroundOperation } from './runtime'

const active = new Map<string, { api: PluginBackendApi; chatId?: string }>()
export type DetailedCompletionResult = AiCompletion
export type OneShotResult = Pick<AiCompletion, 'text' | 'inputTokens' | 'outputTokens' | 'finishReason'>

export function relayAiStream(api: PluginBackendApi, event: AiStreamEvent): void {
  if (active.get(event.requestId)?.api !== api) return
  api.rpc.emit('stream', event)
  if (event.type === 'done') active.delete(event.requestId)
}
export async function startRun(_root: string, request: AiChatRequest): Promise<void> {
  if (request.conversationId) await assertChatWritable(request.conversationId)
  if (active.has(request.requestId)) throw new Error('AI request is already running')
  const api = backendApi()
  active.set(request.requestId, { api, chatId: request.conversationId })
  try { await api.ai.stream(request) }
  catch (error) {
    active.delete(request.requestId)
    api.rpc.emit('stream', { requestId: request.requestId, type: 'error', error: error instanceof Error ? error.message : String(error) })
    api.rpc.emit('stream', { requestId: request.requestId, type: 'done', finishReason: 'error' })
  }
}
export async function cancelRun(requestId: string): Promise<boolean> {
  const api = active.get(requestId)?.api
  if (!api) return false
  try { return await api.ai.cancel(requestId) } finally { active.delete(requestId) }
}
export function runDetailed(root: string, request: AiChatRequest, controller = new AbortController()): Promise<DetailedCompletionResult> {
  return withBackgroundOperation(root, async () => {
    const api = backendApi()
    if (request.conversationId) await assertChatWritable(request.conversationId)
  if (active.has(request.requestId)) throw new Error('AI request is already running')
    controller.signal.throwIfAborted()
    active.set(request.requestId, { api, chatId: request.conversationId })
    let cancelling: Promise<unknown> | undefined
    const abort = (): void => { cancelling = api.ai.cancel(request.requestId); void cancelling.catch(() => {}) }
    controller.signal.addEventListener('abort', abort, { once: true })
    try { return await api.ai.complete(request) }
    finally { controller.signal.removeEventListener('abort', abort); await cancelling; active.delete(request.requestId) }
  })
}
export const runOnce = (root: string, request: AiChatRequest): Promise<OneShotResult> => runDetailed(root, request)
export async function cancelAllRuns(): Promise<void> { await Promise.allSettled([...active.keys()].map(cancelRun)) }

export async function cancelChatRuns(id: string): Promise<void> {
  await Promise.all([stopChatProcesses(id), ...[...active].filter(([, run]) => run.chatId === id).map(([requestId]) => cancelRun(requestId))])
}
