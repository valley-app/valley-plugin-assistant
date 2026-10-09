import { afterEach, beforeEach, vi } from 'vitest'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import type { AiChatThread, ChannelInfo, CustomCommand, AiPersonality } from '../src/types'
import type { RuntimeHooks } from '../src/backend/runtimes'
import { datasetFixture } from './backendDatasetFixture'

const fixtureHooks = vi.hoisted(() => ({
  threads: new Map<string, AiChatThread>(), channels: [] as ChannelInfo[],
  infer: vi.fn(), dispatch: vi.fn(), ingest: vi.fn(), compile: vi.fn(), attachment: vi.fn(), importFile: vi.fn(), attachments: vi.fn(),
  deleted: new Set<string>(), commands: [] as CustomCommand[], profiles: [] as AiPersonality[], settings: {} as Record<string, unknown>
}))
vi.mock('../src/backend/threads', () => ({
  readChat: async (_root: string, id: string) => structuredClone(fixtureHooks.threads.get(id) ?? null),
  saveChat: async (_root: string, thread: AiChatThread) => { if (fixtureHooks.deleted.has(thread.id)) throw new Error('Conversation deleted'); fixtureHooks.threads.set(thread.id, structuredClone(thread)) },
  clearChat: async (_root: string, id: string) => { fixtureHooks.threads.delete(id) },
  readGuardOverrides: async () => null
}))
vi.mock('../src/backend/store', () => ({
  readConfig: async () => ({ routing: { auto: false, default: { provider: 'openai', model: 'test-model' }, rules: [] }, providers: [{ provider: 'openai', configured: true, models: [{ id: 'test-model', contextWindow: 32000 }] }], connections: [{ id: 'openai', provider: 'openai', configured: true, models: [{ id: 'test-model' }] }] }),
  readPersonality: async () => null, readMemory: async () => [], readCommands: async () => fixtureHooks.commands, listPersonalities: async () => fixtureHooks.profiles
}))
vi.mock('../src/backend/configuration/settings', () => ({ effectiveSettings: async () => ({ importMaxBytes: 32 * 1024 * 1024, attachmentParser: 'test-parser', ...fixtureHooks.settings }) }))
vi.mock('../src/backend/configuration/instructions', () => ({ compileInstructions: (...args: unknown[]) => fixtureHooks.compile(...args) }))
vi.mock('../src/backend/projects', () => ({ executionContext: async () => ({ cwd: '/vault', home: '/test-home', root: { id: 'root', path: '/vault' }, roots: [{ id: 'root', path: '/vault' }] }), executionFile: (_access: unknown, rootId: string, path: string) => ({ rootId, path }) }))
vi.mock('../src/backend/chatNaming', () => ({ scheduleChatNaming: vi.fn() }))
vi.mock('../src/backend/attachments', () => ({
  referenceAttachments: vi.fn(async () => {}), importAttachmentFile: fixtureHooks.importFile, listConversationAttachments: fixtureHooks.attachments, conversationAttachmentMetadata: fixtureHooks.attachment,
  assertChatWritable: async (id: string) => { if (fixtureHooks.deleted.has(id)) throw new Error('Conversation deleted') }
}))
vi.mock('../src/backend/ingest', () => ({ ingestAttachment: (...args: unknown[]) => fixtureHooks.ingest(...args) }))
vi.mock('../src/backend/channels/manager', () => ({ channelManager: { list: async () => fixtureHooks.channels, dispatch: (...args: unknown[]) => fixtureHooks.dispatch(...args) } }))
vi.mock('../src/backend/runtimes', () => ({ runNativeRuntime: (...args: unknown[]) => fixtureHooks.infer(...args), steerRuntime: vi.fn() }))

import { AssistantRuntime } from '../src/backend/engine/service'
import { initBackend } from '../src/backend/runtime'

const runtimes: AssistantRuntime[] = []
beforeEach(() => {
  fixtureHooks.threads.clear(); fixtureHooks.deleted.clear(); fixtureHooks.commands = []; fixtureHooks.profiles = []
  fixtureHooks.settings = {}
  fixtureHooks.channels = [
    { id: 'telegram', type: 'telegram', name: 'Field bot', displayName: 'Field bot', configured: true, running: true, allowFrom: ['123'] },
    { id: 'whatsapp-1', type: 'whatsapp', name: 'Fungi channel', displayName: 'Fungi channel', configured: true, running: true, allowFrom: ['15550100001'] }
  ]
  fixtureHooks.infer.mockReset().mockImplementation(async (_input: unknown, _context: unknown, hooks: RuntimeHooks) => { hooks.event({ type: 'message', message: { role: 'assistant', content: 'Reply from agent.' } }) })
  fixtureHooks.dispatch.mockReset().mockResolvedValue(['provider-reply'])
  fixtureHooks.ingest.mockReset().mockResolvedValue({ text: 'Preserved attachment content' })
  fixtureHooks.compile.mockReset().mockResolvedValue({ text: 'Test instructions', hash: 'instructions' })
  fixtureHooks.attachment.mockReset(); fixtureHooks.importFile.mockReset(); fixtureHooks.attachments.mockReset().mockResolvedValue([])
})
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.close())) })

export function createBackendChannelFixture(data = datasetFixture()) {
  const emit = vi.fn()
  const api = {
    data, rpc: { emit }, ai: { complete: vi.fn(), speech: { synthesize: vi.fn() } },
    policy: { read: vi.fn(async () => ({ defaultWrite: { decision: 'confirm' }, tools: {}, commands: {}, files: { visitMode: 'allow-listed-only', defaultRead: { decision: 'allow' }, defaultWrite: { decision: 'confirm' }, allowedToVisit: ['**/*.md'], allowedToWrite: ['**/*.md'], blocked: [], readOverrides: {}, writeOverrides: {} }, dangerousMode: { enabled: false, scope: 'off' }, pluginPresets: {} })) },
    agent: { begin: vi.fn(async () => ({ scopeId: 'scope' })), commands: vi.fn(async () => []), catalog: vi.fn(async () => ({ commands: [], total: 0 })), describe: vi.fn(async () => { throw new Error('Command unavailable') }), close: vi.fn(async () => {}), invoke: vi.fn(async () => {}), onState: vi.fn(() => () => {}), resume: vi.fn(async () => {}) },
    files: { release: vi.fn(async () => {}) }
  } as unknown as PluginBackendApi
  initBackend(api)
  const runtime = new AssistantRuntime(api)
  runtimes.push(runtime)
  return { runtime, api, emit, data }
}

export const channelFixture = fixtureHooks
