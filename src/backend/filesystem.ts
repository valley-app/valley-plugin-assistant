import { t } from './runtime'
import path from 'path-browserify'
import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
import type { PluginStorageGrant, PluginStorageLocation } from '@valley/plugin-sdk/pluginStorage'
import { backendApi, VAULT_ROOT } from './runtime'

const roots: Array<{ area: 'metadata' | 'vault'; path: string; virtual: string }> = [
  { area: 'metadata', path: 'plugins/data/assistant', virtual: `${VAULT_ROOT}/.valley/plugins/data/assistant` }
]
export function bindAttachmentFolder(folder: string): string {
  const normalized = folder.trim().replace(/\/+$/, '')
  if (!normalized) return `${VAULT_ROOT}/.valley/plugins/data/assistant/attachment`
  if (normalized.startsWith('/') || normalized.includes('\\') || normalized.split('/').some(part => !part || part === '.' || part === '..' || part === '.valley')) throw new Error('Invalid attachment folder')
  const virtual = `${VAULT_ROOT}/${normalized}`
  if (!roots.some(root => root.virtual === virtual)) roots.push({ area: 'vault', path: normalized, virtual })
  return virtual
}
export type StorageApi = Pick<PluginBackendOperationContext['api'], 'storage'>
const sessions = new WeakMap<StorageApi, { grants: Map<string, Promise<PluginStorageGrant>>; queues: Map<string, Promise<unknown>> }>()
function session(api: StorageApi) {
  let value = sessions.get(api)
  if (!value) { value = { grants: new Map(), queues: new Map() }; sessions.set(api, value) }
  return value
}
const missing = (file: string): Error => Object.assign(new Error(t('assistant.backend.missingFile', { value: file })), { code: 'ENOENT' })
export async function storageLocation(file: string, mode: 'read' | 'write' = 'write', api: StorageApi = backendApi()): Promise<PluginStorageLocation> {
  const { grants } = session(api)
  const normalized = path.resolve(file)
  const scope = roots.find((root) => normalized === root.virtual || normalized.startsWith(root.virtual + '/'))
  if (!scope) throw new Error(t('assistant.backend.storageBinding', { value: file }))
  const key = `${scope.virtual}:${mode}`
  let pending = (mode === 'read' ? grants.get(`${scope.virtual}:write`) : undefined) ?? grants.get(key)
  if (!pending) {
    pending = api.storage.open({ area: scope.area, path: scope.path, kind: 'directory', mode }).catch((error) => { grants.delete(key); throw error })
    grants.set(key, pending)
  }
  const grant = await pending
  return { handle: grant.handle, path: path.relative(scope.virtual, normalized) }
}

export async function documentLocation(file: string, mode: 'read' | 'write', api: Pick<PluginBackendOperationContext['api'], 'storage'>): Promise<PluginStorageLocation> {
  const normalized = path.resolve(file)
  const scope = roots.find(root => normalized === root.virtual || normalized.startsWith(root.virtual + '/'))
  if (!scope) throw new Error(t('assistant.backend.storageBinding', { value: file }))
  const grant = await api.storage.open({ area: scope.area, path: scope.path, kind: 'directory', mode })
  return { handle: grant.handle, path: path.relative(scope.virtual, normalized) }
}
export async function releaseFileAccess(api: StorageApi = backendApi()): Promise<void> {
  const { grants, queues } = session(api)
  while (queues.size) await Promise.allSettled([...queues.values()])
  const existing = [...grants.values()]
  grants.clear()
  const results = await Promise.allSettled(existing.map(async value => api.storage.close((await value).handle)))
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}
export async function readFile(file: string, _encoding: 'utf8' = 'utf8', api: StorageApi = backendApi()): Promise<string> {
  const location = await storageLocation(file, 'read', api)
  if (!await api.storage.stat(location)) throw missing(file)
  const decoder = new TextDecoder()
  let result = '', offset = 0
  while (true) {
    const chunk = await api.storage.readBytes(location, { offset, maxBytes: 1024 * 1024 })
    result += decoder.decode(Uint8Array.from(atob(chunk.base64), (character) => character.charCodeAt(0)), { stream: !chunk.done })
    if (chunk.done) return result
    if (chunk.nextOffset <= offset) throw new Error(t('assistant.backend.readStalled'))
    offset = chunk.nextOffset
    if (offset > 128 * 1024 * 1024) throw new Error(t('assistant.backend.textLimit'))
  }
}
function* textChunks(content: string): Generator<string> {
  for (let offset = 0; offset < content.length;) {
    let end = Math.min(content.length, offset + 256 * 1024)
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--
    yield content.slice(offset, end)
    offset = end
  }
}
export async function writeFile(file: string, content: string | Uint8Array, _encoding: 'utf8' = 'utf8', api: StorageApi = backendApi()): Promise<void> {
  const location = await storageLocation(file, 'write', api)
  if (typeof content !== 'string') {
    if (!content.length) { await api.storage.writeBytes(location, ''); return }
    for (let offset = 0; offset < content.length; offset += 1024 * 1024) {
      let binary = ''
      const chunk = content.subarray(offset, offset + 1024 * 1024)
      for (let start = 0; start < chunk.length; start += 32768) binary += String.fromCharCode(...chunk.subarray(start, start + 32768))
      await api.storage.writeBytes(location, btoa(binary), offset > 0)
    }
    return
  }
  if (!content) { await api.storage.write(location, ''); return }
  let append = false
  for (const chunk of textChunks(content)) { await api.storage.write(location, chunk, append); append = true }
}
export async function appendFile(file: string, content: string, _encoding: 'utf8' = 'utf8', api: StorageApi = backendApi()): Promise<void> {
  const location = await storageLocation(file, 'write', api)
  for (const chunk of textChunks(content)) await api.storage.write(location, chunk, true)
}
export async function mkdir(file: string, _options?: { recursive?: boolean }, api: StorageApi = backendApi()): Promise<void> { await api.storage.mkdir(await storageLocation(file, 'write', api)) }
export async function rename(from: string, to: string, api: StorageApi = backendApi()): Promise<void> { await api.storage.move(await storageLocation(from, 'write', api), await storageLocation(to, 'write', api)) }
export async function rm(file: string, options?: { recursive?: boolean; force?: boolean }, api: StorageApi = backendApi()): Promise<void> { await api.storage.remove(await storageLocation(file, 'write', api), { recursive: options?.recursive, missingOk: options?.force }) }
export async function unlink(file: string, api: StorageApi = backendApi()): Promise<void> { await rm(file, undefined, api) }
export async function access(file: string, api: StorageApi = backendApi()): Promise<void> { if (!await api.storage.stat(await storageLocation(file, 'read', api))) throw missing(file) }
export async function stat(file: string, api: StorageApi = backendApi()) {
  const result = await api.storage.stat(await storageLocation(file, 'read', api))
  if (!result) throw missing(file)
  return { ...result, mtime: new Date(result.mtimeMs), isFile: () => result.kind === 'file', isDirectory: () => result.kind === 'directory', isSymbolicLink: () => result.kind === 'symlink' }
}
export const lstat = stat
export interface DirectoryEntry { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
export function readdir(file: string, options?: undefined, api?: StorageApi): Promise<string[]>
export function readdir(file: string, options: { withFileTypes: true }, api?: StorageApi): Promise<DirectoryEntry[]>
export async function readdir(file: string, options?: { withFileTypes: true }, api: StorageApi = backendApi()): Promise<string[] | DirectoryEntry[]> {
  const entries = await api.storage.list(await storageLocation(file, 'read', api))
  return options?.withFileTypes ? entries.map((entry) => ({ name: entry.name, isFile: () => entry.kind === 'file', isDirectory: () => entry.kind === 'directory', isSymbolicLink: () => entry.kind === 'symlink' })) : entries.map((entry) => entry.name)
}
export function queueFileWrite<T>(file: string, run: () => Promise<T>, _api: StorageApi = backendApi()): Promise<T> {
  const backend = backendApi()
  const { queues } = session(backend)
  const pending = (queues.get(file) ?? Promise.resolve()).catch(() => undefined).then(() => { if (backendApi() !== backend) throw new Error('Assistant backend changed before queued write'); return run() })
  queues.set(file, pending)
  void pending.finally(() => { if (queues.get(file) === pending) queues.delete(file) }).catch(() => undefined)
  return pending
}
export async function atomicWriteFile(file: string, text: string | Uint8Array, api: StorageApi = backendApi()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true }, api)
  const temporary = `${file}.tmp-${crypto.randomUUID()}`
  try { await writeFile(temporary, text, 'utf8', api); await rename(temporary, file, api) }
  catch (error) { await rm(temporary, { force: true }, api).catch(() => undefined); throw error }
}
