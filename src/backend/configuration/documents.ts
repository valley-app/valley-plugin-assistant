import { backendApi } from '../runtime'
import { documentLocation } from '../filesystem'
import type { PluginBackendOperationContext } from '@valley/plugin-sdk'

export type ConfigurationApi = PluginBackendOperationContext['api']

export function requireRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw Object.assign(new Error('Read the configuration before changing it'), { code: 'REVISION_REQUIRED', outcome: 'not-applied' })
}

export async function readDocument(file: string, api: ConfigurationApi = backendApi()): Promise<{ content: string; revision: number }> {
  const location = await documentLocation(file, 'read', api)
  try { return await api.storage.readDocument(location) } finally { await api.storage.close(location.handle) }
}

export async function writeDocument(file: string, content: string | null, expectedRevision: number, api: ConfigurationApi = backendApi()): Promise<{ revision: number }> {
  requireRevision(expectedRevision)
  const location = await documentLocation(file, 'write', api)
  try { return await api.storage.writeDocument(location, { content, expectedRevision }) } finally { await api.storage.close(location.handle) }
}

export async function writeDocuments(entries: Array<{ file: string; content: string | null; expectedRevision: number }>, api: ConfigurationApi = backendApi()): Promise<{ revisions: number[] }> {
  for (const entry of entries) requireRevision(entry.expectedRevision)
  const values: Array<{ location: { handle: string; path: string }; content: string | null; expectedRevision: number }> = []
  try {
    for (const entry of entries) values.push({ location: await documentLocation(entry.file, 'write', api), content: entry.content, expectedRevision: entry.expectedRevision })
    return await api.storage.writeDocuments(values)
  } finally { await Promise.all(values.map(value => api.storage.close(value.location.handle))) }
}
