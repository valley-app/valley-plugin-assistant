import { createMockValleyApi as createHostMock } from '@valley/plugin-testkit'
import type { AiStreamEvent, ChannelMessage, ChannelInfo, AiChatThread, AiMemoryEntry, AiPersonality, CustomCommand, AssistantConfig, AiUsageStats, AiModelInfo, AiProviderStatus, AiConnectionStatus } from '../src/types'
import type { GuardOverrides, PendingApprovalRecord } from '@valley/plugin-sdk/guard/types'
import type { ValleyPluginApi } from '../src/api'
import type { ComponentProps } from 'react'
import { vi } from 'vitest'
export type MockOptions = Parameters<typeof createHostMock>[0] & { channels?: ChannelInfo[]; commands?: CustomCommand[]; aiConfig?: AssistantConfig; aiUsage?: AiUsageStats; aiModels?: Record<string, AiModelInfo[]>; aiProviders?: AiProviderStatus[]; aiConnections?: AiConnectionStatus[] }
export function createMockValleyApi(options: MockOptions = {}) {
  const mock = createHostMock(options)
  const driverCalls = mock.driverCalls
  const aiStreamListeners = new Set<(event: AiStreamEvent) => void>()
  const channelMessageListeners = new Set<(message: ChannelMessage) => void>()
  const channelsState: ChannelInfo[] = [...(options.channels ?? [])]
  const chatThreads = new Map<string, AiChatThread>()
  const chatMemory = new Map<string, AiMemoryEntry[]>()
  const pendingApprovals = new Map<string, PendingApprovalRecord>()
  const guardOverrides = new Map<string, GuardOverrides>()
  const personalities = new Map<string, AiPersonality>()
  let overallCommands: CustomCommand[] = [...(options.commands ?? [])]
  const defaultAiConfig: AssistantConfig = {
    instructions: 'Test instructions',
    rules: [],
    routing: { auto: true, default: { provider: 'anthropic', model: 'claude-opus-4-8' }, fast: { provider: 'anthropic', model: 'claude-haiku-4-5' }, rules: [] },
    guard: {
      defaultWrite: { decision: 'confirm', allowPreApproval: false },
      tools: {},
      commands: {},
      files: {
        visitMode: 'allow-all-except-blocked',
        defaultRead: { decision: 'allow' },
        defaultWrite: { decision: 'confirm', allowPreApproval: false },
        allowedToVisit: ['**/*'],
        allowedToWrite: ['**/*.md'],
        blocked: ['.valley/assistant', '.valley/**/secrets.json'],
        readOverrides: {},
        writeOverrides: {}
      },
      dangerousMode: { enabled: false, scope: 'off' },
      pluginPresets: {}
    },
    providers: [],
    connections: []
  }
  let guardPolicy = (options.aiConfig ?? defaultAiConfig).guard
  const emptyBucket = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }
  const defaultAiUsage: AiUsageStats = {
    month: { ...emptyBucket },
    allTime: { ...emptyBucket },
    byProvider: [],
    byConnection: [],
    byModel: [],
    byDay: [],
    trend: { daily: [], weekly: [], monthly: [] },
    budget: {},
    recentEntries: [],
    since: null
  }


  const recordDriver = async (driver: string, method: string, payload: unknown): Promise<{ ok: true }> => { driverCalls.push({ driver, method, payload }); return { ok: true } }
  const accessControl = vi.fn(({ variant, disabled, onChange }: ComponentProps<ValleyPluginApi['ui']['AccessControl']>) => mock.api.React.createElement('button', { type: 'button', disabled, 'data-host-access-control': variant, onClick: () => onChange?.('full') }, 'Host access control'))
  const api: ValleyPluginApi = { ...mock.api,
      ui: { ...mock.api.ui, AccessControl: accessControl },
      backend: { ...mock.api.backend, call: (async (method: string, payload: unknown) => {
        if (method === 'session.snapshot') return null
        if (method === 'projects.request' && (payload as { method?: string })?.method === 'execution') {
          const mode = guardPolicy.dangerousMode.enabled ? 'full' : 'vault'
          const root = { id: '00000000-0000-4000-8000-000000000001', projectId: `access-${mode}`, path: mode === 'full' ? '/' : '/vault', name: mode }
          return { mode, root, roots: [root], cwd: '/vault', home: '/fixture-home' }
        }
        return mock.api.backend.call(method, payload)
      }) as typeof mock.api.backend.call },
      assistant: {
        chat: async (request) => {
          await recordDriver('ai', 'chat', request)
          return { ok: true, data: { requestId: request.requestId } }
        },
        cancel: (requestId) => recordDriver('ai', 'cancel', { requestId }),
        listModels: async (provider) => {
          await recordDriver('ai', 'listModels', { provider })
          return { ok: true, data: { models: options.aiModels?.[provider] ?? [] } }
        },
        providerStatus: async () => {
          await recordDriver('ai', 'providerStatus', {})
          return { ok: true, data: { providers: options.aiProviders ?? [] } }
        },
        listConnections: async () => {
          await recordDriver('ai', 'listConnections', {})
          return { ok: true, data: { connections: options.aiConnections ?? [] } }
        },
        getConfig: async () => {
          await recordDriver('ai', 'getConfig', {})
          const config = options.aiConfig ?? defaultAiConfig
          config.guard = guardPolicy
          return { ok: true, data: config }
        },
        writeRule: (name, content) => recordDriver('ai', 'writeRule', { name, content }),
        getGuard: async () => {
          await recordDriver('ai', 'getGuard', {})
          return { ok: true, data: { guard: guardPolicy } }
        },
        saveGuard: async (policy) => {
          await recordDriver('ai', 'saveGuard', { policy })
          guardPolicy = policy
          return { ok: true, data: { guard: guardPolicy } }
        },
        appendGuardAudit: (entry) => recordDriver('ai', 'appendGuardAudit', { entry }),
        addPending: async (record) => {
          const result = await recordDriver('ai', 'addPending', { record })
          pendingApprovals.set(record.requestId, record)
          return result
        },
        removePending: async (requestId) => {
          const result = await recordDriver('ai', 'removePending', { requestId })
          pendingApprovals.delete(requestId)
          return result
        },
        listPending: async () => {
          await recordDriver('ai', 'listPending', {})
          return { ok: true, data: { pending: [...pendingApprovals.values()] } }
        },
        listChats: async () => {
          await recordDriver('ai', 'listChats', {})
          return {
            ok: true,
            data: {
              chats: [...chatThreads.values()].map((t) => ({
                id: t.id,
                title: t.title,
                projectId: t.projectId,
                pinned: t.pinned,
                preview: [...t.messages].reverse().find(message => message.role === 'assistant' || message.role === 'user')?.content,
                updatedAt: t.updatedAt,
                source: t.source,
                channelId: t.channelId,
                channelIdentity: t.channelIdentity,
                channelName: t.channelName
              }))
            }
          }
        },
        readChat: async (id) => {
          await recordDriver('ai', 'readChat', { id })
          return { ok: true, data: { thread: chatThreads.get(id) ?? ({} as AiChatThread) } }
        },
        saveChat: async (thread) => {
          const result = await recordDriver('ai', 'saveChat', { thread })
          chatThreads.set(thread.id, thread)
          return result
        },
        renameChat: async (id, title) => {
          const result = await recordDriver('ai', 'renameChat', { id, title })
          const t = chatThreads.get(id)
          if (t) chatThreads.set(id, { ...t, ...(t.source ? { channelIdentity: t.channelIdentity || t.title } : {}), title })
          return result
        },
        deleteChat: async (id) => {
          const result = await recordDriver('ai', 'deleteChat', { id })
          chatThreads.delete(id)
          chatMemory.delete(id)
          return result
        },
        clearChat: async (id) => {
          const result = await recordDriver('ai', 'clearChat', { id })
          // `/clear`: drop the thread, keep the memory (mirrors the real store).
          chatThreads.delete(id)
          return result
        },
        setChatPinned: async (id, pinned) => {
          const result = await recordDriver('ai', 'setChatPinned', { id, pinned })
          const t = chatThreads.get(id)
          if (t) chatThreads.set(id, { ...t, pinned })
          return result
        },
        readGuardOverrides: async (chatId) => {
          await recordDriver('ai', 'readGuardOverrides', { chatId })
          return { ok: true, data: { overrides: guardOverrides.get(chatId) ?? null } }
        },
        saveGuardOverrides: async (chatId, overrides) => {
          const result = await recordDriver('ai', 'saveGuardOverrides', { chatId, overrides })
          guardOverrides.set(chatId, overrides)
          return result
        },
        listPersonalities: async () => {
          await recordDriver('ai', 'listPersonalities', {})
          return { ok: true, data: { personalities: [...personalities.values()] } }
        },
        readPersonality: async (id) => {
          await recordDriver('ai', 'readPersonality', { id })
          return { ok: true, data: { personality: personalities.get(id) ?? null } }
        },
        savePersonality: async (personality) => {
          const result = await recordDriver('ai', 'savePersonality', { personality })
          personalities.set(personality.id, personality)
          return result
        },
        deletePersonality: async (id) => {
          const result = await recordDriver('ai', 'deletePersonality', { id })
          if (id !== 'default') personalities.delete(id)
          return result
        },
        listCommands: async () => {
          await recordDriver('ai', 'listCommands', {})
          return { ok: true, data: { commands: [...overallCommands], configurationRevisions: { 'commands.md': 0 } } }
        },
        saveCommands: async (commands) => {
          const result = await recordDriver('ai', 'saveCommands', { commands })
          overallCommands = [...commands]
          return result
        },
        appendMemory: async (chatId, entry) => {
          const result = await recordDriver('ai', 'appendMemory', { chatId, entry })
          chatMemory.set(chatId, [...(chatMemory.get(chatId) ?? []), entry])
          return result
        },
        readMemory: async (chatId) => {
          await recordDriver('ai', 'readMemory', { chatId })
          return { ok: true, data: { memory: chatMemory.get(chatId) ?? [] } }
        },
        onStream: (cb) => {
          aiStreamListeners.add(cb)
          return () => aiStreamListeners.delete(cb)
        },
        ingestAttachment: async (request) => {
          await recordDriver('ai', 'ingestAttachment', request)
          return { ok: true, data: { text: '' } }
        },
        listHarnesses: async () => {
          await recordDriver('ai', 'listHarnesses', {})
          return { ok: true, data: { harnesses: [] } }
        },
        readHarnessPackage: async (id) => {
          await recordDriver('ai', 'readHarnessPackage', { id })
          return { ok: true, data: { package: null } }
        },
        createHarness: async (input) => {
          await recordDriver('ai', 'createHarness', { package: input })
          return { ok: true, data: { harnesses: [] } }
        },
        writeHarnessFile: async (id, path, content, baseline) => {
          await recordDriver('ai', 'writeHarnessFile', { id, path, content, baseline })
          return { ok: false, reason: 'error' }
        },
        updateHarnessManifest: async (id, manifest, baseline) => {
          await recordDriver('ai', 'updateHarnessManifest', { id, manifest, baseline })
          return { ok: false, reason: 'error' }
        },
        updateHarnessConfig: async (id, config, baseline) => {
          await recordDriver('ai', 'updateHarnessConfig', { id, config, baseline })
          return { ok: false, reason: 'error' }
        },
        saveHarnessSettings: async (id, values) => {
          await recordDriver('ai', 'saveHarnessSettings', { id, values })
          return { ok: true, data: { harnesses: [] } }
        },
        reloadHarnesses: async () => {
          await recordDriver('ai', 'reloadHarnesses', {})
          return { ok: true, data: { harnesses: [] } }
        },
        runHarness: async (id, targets, runOptions) => {
          await recordDriver('ai', 'runHarness', { id, targets, options: runOptions })
          return { ok: true, data: { run: null } }
        },
        cancelHarnessRun: (runId) => recordDriver('ai', 'cancelHarnessRun', { runId }),
        listHarnessRuns: async (id, limit) => {
          await recordDriver('ai', 'listHarnessRuns', { id, limit })
          return { ok: true, data: { runs: [] } }
        },
        readHarnessRun: async (runId) => {
          await recordDriver('ai', 'readHarnessRun', { runId })
          return { ok: true, data: { run: null } }
        },
        clearHarnessCache: (id) => recordDriver('ai', 'clearHarnessCache', { id }),
        onHarnessEvent: () => () => {}
      },
      channels: {
        list: async () => {
          await recordDriver('channels', 'list', {})
          return { ok: true, data: { channels: channelsState } }
        },
        add: async (type, name) => {
          await recordDriver('channels', 'add', { type, name })
          const id = `${type}-${channelsState.length + 1}`
          channelsState.push({ id, type, name, displayName: name, configured: false, running: false, allowFrom: [] })
          return { ok: true, data: { id, channels: channelsState } }
        },
        remove: async (channelId) => {
          await recordDriver('channels', 'remove', { channelId })
          const i = channelsState.findIndex((c) => c.id === channelId)
          if (i >= 0) channelsState.splice(i, 1)
          return { ok: true, data: { channels: channelsState } }
        },
        rename: async (channelId, name) => {
          await recordDriver('channels', 'rename', { channelId, name })
          const c = channelsState.find((c) => c.id === channelId)
          if (c) {
            c.name = name
            c.displayName = name
          }
          return { ok: true, data: { channels: channelsState } }
        },
        setSecret: async (channelId, secret) => {
          await recordDriver('channels', 'setSecret', { channelId, secret })
          return { ok: true, data: { channels: channelsState } }
        },
        setSecretField: async (channelId, key, secret) => {
          await recordDriver('channels', 'setSecretField', { channelId, key, secret })
          return { ok: true, data: { channels: channelsState } }
        },
        setConfig: async (channelId, config) => {
          await recordDriver('channels', 'setConfig', { channelId, config })
          return { ok: true, data: { channels: channelsState } }
        },
        start: async (channelId) => {
          await recordDriver('channels', 'start', { channelId })
          return { ok: true, data: { channels: channelsState } }
        },
        stop: async (channelId) => {
          await recordDriver('channels', 'stop', { channelId })
          return { ok: true, data: { channels: channelsState } }
        },
        send: (channelId, chatRef, text) => recordDriver('channels', 'send', { channelId, chatRef, text }),
        sendButtons: (channelId, chatRef, text, buttons) =>
          recordDriver('channels', 'sendButtons', { channelId, chatRef, text, buttons }),
        sendAttachment: (channelId, chatRef, path, caption) =>
          recordDriver('channels', 'sendAttachment', { channelId, chatRef, path, caption }),
        onMessage: (cb) => {
          channelMessageListeners.add(cb)
          return () => channelMessageListeners.delete(cb)
        }
      }
  }
  return { ...mock, api, accessControl, chatThreads, chatMemory, pendingApprovals, guardOverrides,
    emitAiStream: (event: AiStreamEvent) => aiStreamListeners.forEach((listener) => listener(event)),
    emitChannelMessage: (event: ChannelMessage) => channelMessageListeners.forEach((listener) => listener(event))
  }
}

export type MockValleyApi = ReturnType<typeof createMockValleyApi>
