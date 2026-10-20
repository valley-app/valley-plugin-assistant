import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { backendApi, backendClosing } from './runtime'
const active = new Map<string, Set<() => void>>()
const stopping = new Map<string, number>()
export const runtimeScope = (chatId: string): string => bytesToHex(sha256(new TextEncoder().encode(chatId)))
export function trackProcessScope(chatId: string, stop: () => void): () => void {
  if (backendClosing()) throw new Error('Assistant backend is closing')
  const callbacks = active.get(chatId) ?? new Set<() => void>()
  callbacks.add(stop); active.set(chatId, callbacks)
  return () => { callbacks.delete(stop); if (!callbacks.size) active.delete(chatId) }
}
export const chatStopping = (chatId: string): boolean => stopping.has(chatId)
export function markChatStopping(chatId: string): () => void {
  stopping.set(chatId, (stopping.get(chatId) ?? 0) + 1)
  let done = false
  return () => { if (done) return; done = true; const left = (stopping.get(chatId) ?? 1) - 1; if (left) stopping.set(chatId, left); else stopping.delete(chatId) }
}
export async function stopChatProcesses(chatId: string, removeHome = false, api: Pick<PluginBackendOperationContext['api'], 'process'> = backendApi()): Promise<void> {
  const done = markChatStopping(chatId)
  try {
    for (const stop of active.get(chatId) ?? []) stop()
    await api.process.shutdown(runtimeScope(chatId), removeHome)
  } finally { done() }
}
export async function stopProjectProcesses(): Promise<void> {
  await Promise.all([...active.keys()].map(chatId => stopChatProcesses(chatId)))
}
