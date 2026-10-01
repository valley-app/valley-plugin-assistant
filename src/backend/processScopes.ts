import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { backendApi, backendClosing } from './runtime'
const active = new Map<string, Set<() => void>>()
export const runtimeScope = (chatId: string): string => bytesToHex(sha256(new TextEncoder().encode(chatId)))
export function trackProcessScope(chatId: string, stop: () => void): () => void {
  if (backendClosing()) throw new Error('Assistant backend is closing')
  const callbacks = active.get(chatId) ?? new Set<() => void>()
  callbacks.add(stop); active.set(chatId, callbacks)
  return () => { callbacks.delete(stop); if (!callbacks.size) active.delete(chatId) }
}
export async function stopChatProcesses(chatId: string, removeHome = false, api: Pick<PluginBackendOperationContext['api'], 'process'> = backendApi()): Promise<void> {
  for (const stop of active.get(chatId) ?? []) stop()
  await api.process.shutdown(runtimeScope(chatId), removeHome)
}
export async function stopProjectProcesses(): Promise<void> {
  await Promise.all([...active.keys()].map(chatId => stopChatProcesses(chatId)))
}
