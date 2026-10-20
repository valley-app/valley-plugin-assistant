import type { PluginBackendApi } from '@valley/plugin-sdk'

// Each guest turn may use 1000 ms of CPU. Loading the whole backend and registering it in the start turn can exceed that
// on slower cores, so a host timer ends the turn between the large libraries, the backend graph and registration.
const nextTurn = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

export async function register(api: PluginBackendApi): Promise<() => Promise<void>> {
  for (const load of [() => import('zod'), () => import('yaml')]) { await nextTurn(); await load() }
  await nextTurn()
  const backend = await import('./index')
  await nextTurn()
  return backend.register(api)
}
