import { beforeEach, vi } from 'vitest'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { datasetFixture } from './backendDatasetFixture'
import { initBackend } from '../src/backend/runtime'

vi.mock('../src/backend/filesystem', async (original) => {
  const actual = await original<typeof import('../src/backend/filesystem')>()
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  return {
    ...actual, ...fs,
    storageLocation: async (file: string) => ({ handle: 'fixture-storage', path: file }),
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
    policy: { checkFile: async () => {}, read: async () => ({ defaultWrite: { decision: 'confirm' }, tools: {}, commands: {}, files: { defaultRead: { decision: 'allow' }, defaultWrite: { decision: 'confirm' }, blocked: [], allowedToVisit: ['**'], allowedToWrite: ['**'] } }) },
    ai: { connections: sharedConnections, models: discoveredModels, cancel: cancelDiscovery },
    settings: { get: () => ({}) },
    accounts: { list: async () => [] },
    credentials: { state: async (key: string) => credentials.has(key) ? 'ok' : 'absent', set: async (key: string, value: string) => { if (value) credentials.add(key); else credentials.delete(key) }, delete: async (key: string) => { credentials.delete(key) }, handle: async (key: string) => credentials.has(key) ? `opaque:${key}` : null },
    rpc: { emit: vi.fn() }
  } as unknown as PluginBackendApi)
})
