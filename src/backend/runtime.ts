import english from '../../locales/en.json'
import type { PluginBackendApi } from '@valley/plugin-sdk'

let current: PluginBackendApi | undefined
const pending = new WeakMap<PluginBackendApi, Set<Promise<unknown>>>()
const closing = new WeakSet<PluginBackendApi>()
export const VAULT_ROOT = '/vault'
export function initBackend(api: PluginBackendApi): void { current = api; closing.delete(api) }
export function backendApi(): PluginBackendApi { if (!current) throw new Error(t('assistant.backend.backendUnavailable')); return current }
export function emitDriverEvent(_driver: string, event: string, payload: unknown): void { backendApi().rpc.emit(event, payload) }
export function withBackgroundOperation<T>(_root: string, operation: () => Promise<T>): Promise<T> {
  const owner = backendApi()
  if (closing.has(owner)) return Promise.reject(new Error('Assistant backend is closing'))
  const tasks = pending.get(owner) ?? new Set<Promise<unknown>>()
  pending.set(owner, tasks)
  const task = Promise.resolve().then(() => { if (backendApi() !== owner) throw new Error('Assistant backend changed before operation'); return operation() })
  tasks.add(task)
  void task.then(() => tasks.delete(task), () => tasks.delete(task))
  return task
}
export const backendClosing = (api = backendApi()): boolean => closing.has(api)
export function closeBackend(api: PluginBackendApi): void { closing.add(api) }
export async function drainBackgroundOperations(api: PluginBackendApi): Promise<void> {
  const tasks = pending.get(api)
  while (tasks?.size) await Promise.allSettled([...tasks])
}

export function t(key: string, params?: Record<string, string | number>): string {
  if (current?.i18n) return current.i18n.t(key, params)
  const value = (english as Record<string, string>)[key] ?? key
  return value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params?.[name] ?? `{{${name}}}`))
}
