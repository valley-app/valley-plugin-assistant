import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
type OwnerApi = PluginBackendOperationContext['api']
import { t } from './runtime'
import type { PluginCredentialStore, PluginSocketEndpoint } from '@valley/plugin-sdk/pluginNetwork'
import { backendApi } from './runtime'
export type SecretState = 'absent' | 'ok' | 'unreadable'
export const channelKey = (id: string): string => `channel:${id}`
export const channelSecretKey = (id: string, name: string): string => `channel:${id}:${name}`
const storeFor = async (_root: string, _key: string, _api: OwnerApi = backendApi()): Promise<PluginCredentialStore> => ({ file: 'credentials.json', valueField: 'value' })
export function credentialEndpoint(baseUrl: string): PluginSocketEndpoint {
  const url = new URL(baseUrl)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(t('assistant.backend.httpsRequired'))
  return { host: url.hostname, port: Number(url.port || 443), security: 'tls' }
}
export async function setSecret(root: string, key: string, value: string, endpoints: PluginSocketEndpoint[]): Promise<void> {
  if (!value) return deleteSecret(root, key)
  const api = backendApi()
  await api.credentials.set(key, value, endpoints, await storeFor(root, key, api))
}
export async function secretState(root: string, key: string, api: OwnerApi = backendApi()): Promise<SecretState> { return api.credentials.state(key, await storeFor(root, key, api)) }
export async function hasSecret(root: string, key: string, api: OwnerApi = backendApi()): Promise<boolean> { return await secretState(root, key, api) !== 'absent' }
const sources = new Map<string, { root: string; key: string; api: OwnerApi; lifetime: ReturnType<typeof backendApi> }>()
export async function credentialForEndpoint(handle: string, url: string, api?: OwnerApi): Promise<string> {
  const source = sources.get(handle)
  if (!source) return handle
  if (backendApi() !== source.lifetime) throw new Error('Channel credential belongs to an obsolete backend')
  const credential = await getCredential(source.root, source.key, [credentialEndpoint(url)], api ?? source.api)
  if (!credential) throw new Error(t('assistant.backend.missingChannelCredential'))
  return credential
}
export async function getCredential(root: string, key: string, endpoints: PluginSocketEndpoint[], api: OwnerApi = backendApi()): Promise<string | null> {
  if (await secretState(root, key, api) !== 'ok') return null
  const handle = await api.credentials.handle(key, { store: await storeFor(root, key, api), endpoints })
  sources.set(handle, { root, key, api, lifetime: backendApi() })
  if (sources.size > 512) sources.delete(sources.keys().next().value!)
  return handle
}
export async function deleteSecret(root: string, key: string): Promise<void> { const api = backendApi(); await api.credentials.delete(key, await storeFor(root, key, api)) }
