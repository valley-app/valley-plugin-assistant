import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
type OwnerApi = PluginBackendOperationContext['api']
import { t } from '../runtime'
import path from 'path-browserify'
import type { PluginFetchRequest } from '@valley/plugin-sdk/pluginNetwork'
import { backendApi, VAULT_ROOT } from '../runtime'
import { brokerFetch } from './brokerFetch'
import { credentialForEndpoint } from '../secrets'
import { openOwnedAttachment, findAttachment } from '../attachments'

export async function readBoundedMedia(response: Response, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  const expected = Number(response.headers.get('content-length'))
  if (Number.isFinite(expected) && expected > limit) { await response.body?.cancel(); throw new Error(`Media exceeds the ${limit}-byte download limit`) }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Media response has no body')
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      signal?.throwIfAborted()
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > limit) throw new Error(`Media exceeds the ${limit}-byte download limit`)
      chunks.push(part.value)
    }
    if (!size) throw new Error('Media response is empty')
    const bytes = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    return bytes
  } catch (error) { await reader.cancel().catch(() => undefined); throw error }
  finally { reader.releaseLock() }
}

export async function telegramFetch(url: string, input: RequestInit = {}, api: OwnerApi = backendApi()): Promise<Response> {
  const target = new URL(url)
  const parts = target.pathname.split('/')
  const index = parts.findIndex((part) => /^bot[0-9a-f-]{36}$/.test(part))
  if (index < 0 || target.origin !== 'https://api.telegram.org') throw new Error(t('assistant.backend.invalidEndpoint'))
  const handle = parts[index].slice(3)
  parts[index] = ':token'
  target.pathname = parts.join('/')
  return brokerFetch(target.toString(), { ...input, headers: Object.fromEntries(new Headers(input.headers)), stream: true, credential: { handle, placement: 'path', name: 'token', prefix: 'bot' } }, api)
}
export async function whatsappFetch(url: string, input: RequestInit = {}, api: OwnerApi = backendApi()): Promise<Response> {
  const headers = new Headers(input.headers)
  const handle = headers.get('authorization')?.replace(/^Bearer /, '')
  if (!handle) throw new Error(t('assistant.backend.missingChannelCredential'))
  headers.delete('authorization')
  return brokerFetch(url, { ...input, headers: Object.fromEntries(headers), stream: true, credential: { handle: await credentialForEndpoint(handle, url, api), placement: 'header', name: 'Authorization', prefix: 'Bearer ' } }, api)
}
export async function uploadFile(url: string, credential: NonNullable<PluginFetchRequest['credential']>, absolutePath: string, fields: Record<string, string>, field: string, options?: { fileName?: string; mimeType?: string; maxBytes?: number }, api: OwnerApi = backendApi()): Promise<Response> {
  const relative = path.relative(VAULT_ROOT, absolutePath)
  if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error(t('assistant.backend.outsideVault'))
  const file = await openOwnedAttachment(relative, api) ?? await api.files.openVault(relative)
  const attachment = await findAttachment(relative, api)
  try {
    if (file.size > (options?.maxBytes ?? 32 * 1024 * 1024)) throw new Error('Attachment exceeds the destination size limit')
    const part = { name: field, handle: file.handle, ...(attachment ? { fileName: attachment.fileName, mimeType: attachment.mime } : {}), ...(options?.fileName ? { fileName: options.fileName } : {}), ...(options?.mimeType ? { mimeType: options.mimeType } : {}) }
    const result = await api.network.fetch({ url, method: 'POST', requestId: crypto.randomUUID(), credential, multipart: { fields, files: [part] } })
    return new Response(Uint8Array.from(atob(result.bodyBase64), (character) => character.charCodeAt(0)), { status: result.status, headers: result.headers })
  } finally { await api.files.release([file.handle]) }
}
