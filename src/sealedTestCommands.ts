import { commandRegistrar } from './commandResults'
import type { ValleyPluginApi } from './api'
import { getStore } from './store'

// Sealed test fixtures only: published after the backend's sealed-test probe (backend/sealedTest.ts) succeeded, never otherwise.
const string = { type: 'string', minLength: 1, maxLength: 256 }
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const input = <T extends Record<string, string>>(keys: (keyof T & string)[]) => ({
  schema: object(Object.fromEntries(keys.map(key => [key, string]))),
  parse: (raw: unknown): T => {
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => typeof value[key] !== 'string' || !value[key])) throw new Error(`Expected exactly ${keys.join(', ')}`)
    return Object.fromEntries(keys.map(key => [key, value[key]])) as T
  }
})
export function registerSealedTestCommands(api: ValleyPluginApi): () => void {
  let disposed = false, offs: Array<() => void> = []
  const register = commandRegistrar(api)
  void api.backend.call<boolean>('test.sealed', {}).then(sealed => {
    if (sealed !== true || disposed) return
    offs = [
      register({ id: 'test-session-capture', label: 'Assistant test: capture a conversation before a turn', paletteSafe: false, sideEffect: 'read', outputSchema: object({ captureId: string }), input: input<{ conversationId: string }>(['conversationId']), run: value => api.backend.callOperation<{ captureId: string }>('test.captureSession', value) }),
      register({ id: 'test-session-forget', label: 'Assistant test: forget a conversation turn', paletteSafe: false, sideEffect: 'write', outputSchema: { type: 'object' }, input: input<{ captureId: string; conversationId: string }>(['captureId', 'conversationId']), run: async value => {
        const result = await api.backend.callOperation<Record<string, unknown>>('test.forgetSession', value)
        await getStore(api).forgetSession(value.conversationId)
        return { value: result, revert: null }
      } }),
      register({ id: 'test-harness-capture', label: 'Assistant test: capture a harness before a run', paletteSafe: false, sideEffect: 'read', outputSchema: object({ captureId: string }), input: input<{ id: string }>(['id']), run: value => api.backend.callOperation<{ captureId: string }>('test.captureHarness', value) }),
      register({ id: 'test-harness-forget', label: 'Assistant test: forget a harness run', paletteSafe: false, sideEffect: 'write', outputSchema: { type: 'object' }, input: input<{ captureId: string; runId: string }>(['captureId', 'runId']), run: async value => ({ value: await api.backend.callOperation<Record<string, unknown>>('test.forgetHarness', value), revert: null }) })
    ]
  }, () => {})
  return () => { disposed = true; offs.forEach(off => off()) }
}
