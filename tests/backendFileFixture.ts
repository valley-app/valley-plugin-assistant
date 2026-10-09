import { beforeEach, vi } from 'vitest'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { datasetFixture } from './backendDatasetFixture'
import { initBackend } from '../src/backend/runtime'
import { promises as files } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'

const documentRevisions = new Map<string, { revision: number; digest: string }>()
let documentTail: Promise<unknown> = Promise.resolve()
const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
  const result = documentTail.catch(() => undefined).then(work)
  documentTail = result
  return result
}
const readDocument = async ({ path }: { path: string }) => {
  const content = await files.readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  const digest = createHash('sha256').update(content).digest('hex'), previous = documentRevisions.get(path)
  const record = { digest, revision: previous ? previous.revision + Number(previous.digest !== digest) : 0 }
  documentRevisions.set(path, record)
  return { content, revision: record.revision }
}
const writeDocuments = (entries: Array<{ location: { path: string }; content: string | null; expectedRevision: number }>) => exclusive(async () => {
  const current = await Promise.all(entries.map(entry => readDocument(entry.location)))
  entries.forEach((entry, index) => {
    if (current[index].revision !== entry.expectedRevision) throw Object.assign(new Error('Configuration changed; reload before saving'), { code: 'REVISION_CONFLICT', outcome: 'not-applied', currentRevision: current[index].revision })
  })
  for (const entry of entries) {
    if (entry.content === null) await files.rm(entry.location.path, { force: true })
    else { await files.mkdir(dirname(entry.location.path), { recursive: true }); await files.writeFile(entry.location.path, entry.content) }
  }
  return { revisions: await Promise.all(entries.map(async entry => (await readDocument(entry.location)).revision)) }
})

vi.mock('../src/backend/filesystem', async (original) => {
  const actual = await original<typeof import('../src/backend/filesystem')>()
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  return {
    ...actual, ...fs,
    access: (file: string) => fs.access(file),
    stat: (file: string) => fs.stat(file),
    lstat: (file: string) => fs.lstat(file),
    storageLocation: async (file: string) => ({ handle: 'fixture-storage', path: file }),
    documentLocation: async (file: string) => ({ handle: 'fixture-document', path: file }),
    atomicWriteFile: async (file: string, content: string) => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      const temporary = `${file}.${crypto.randomUUID()}.tmp`
      await fs.writeFile(temporary, content)
      await fs.rename(temporary, file)
    }
  }
})

vi.mock('../src/backend/channels/network', () => ({ telegramFetch: (...args: Parameters<typeof fetch>) => fetch(...args), uploadFile: vi.fn() }))



export const sharedConnections = vi.fn()
export const discoveredModels = vi.fn()
export const cancelDiscovery = vi.fn()

beforeEach(() => {
  discoveredModels.mockResolvedValue([])
  cancelDiscovery.mockResolvedValue(true)
  sharedConnections.mockResolvedValue([
    { id: 'ollama', provider: 'ollama', providerCapabilities: ['chat'], requiresKey: false, configured: true, authMode: 'none', models: [] },
    { id: 'anthropic', provider: 'anthropic', providerCapabilities: ['chat'], requiresKey: true, configured: false, authMode: 'api-key', models: [] }
  ])
  const credentials = new Set<string>()
  initBackend({
    process: { shutdown: vi.fn(async () => {}) },
    data: datasetFixture(),
    storage: {
      close: async () => {},
      list: async (location: { path: string }) => (await files.readdir(location.path, { withFileTypes: true })).map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file', size: 0, mtimeMs: 0 })),
      readDocument: (location: { path: string }) => exclusive(() => readDocument(location)),
      writeDocuments,
      writeDocument: async (location: { path: string }, input: { content: string | null; expectedRevision: number }) => ({ revision: (await writeDocuments([{ location, ...input }])).revisions[0] })
    },
    policy: { checkFile: async () => {}, read: async () => ({ defaultWrite: { decision: 'confirm' }, tools: {}, commands: {}, files: { defaultRead: { decision: 'allow' }, defaultWrite: { decision: 'confirm' }, blocked: [], allowedToVisit: ['**'], allowedToWrite: ['**'] } }) },
    ai: { connections: sharedConnections, models: discoveredModels, cancel: cancelDiscovery },
    settings: { get: () => ({}) },
    accounts: { list: async () => [] },
    credentials: { presence: async (key: string) => credentials.has(key) ? 'stored' : 'absent', state: async (key: string) => credentials.has(key) ? 'ok' : 'absent', set: async (key: string, value: string) => { if (value) credentials.add(key); else credentials.delete(key) }, delete: async (key: string) => { credentials.delete(key) }, handle: async (key: string) => credentials.has(key) ? `opaque:${key}` : null },
    rpc: { emit: vi.fn() }
  } as unknown as PluginBackendApi)
})
