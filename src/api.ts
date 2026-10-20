import type { SettingsDocument } from './backend/configuration/settings'
import type { HarnessEvent } from './harnessTypes'
import type { ValleyPluginApi as HostApi } from '@valley/plugin-sdk'
import type { DriverResult } from '@valley/plugin-sdk/types'
import type { ChannelsInfo, AiStreamEvent, ChannelMessage } from './types'
import type { AiDriver, ChannelDriver, AiBalanceResult, AiChatListResult, AiChatStartResult, AiChatThreadResult, AiCommandsResult, AiConfigResult, AiConnectionsResult, AiGuardOverridesResult, AiGuardResult, AiHarnessPackageResult, AiHarnessRunResult, AiHarnessRunsResult, AiHarnessesResult, AiMemoryResult, AiModelsResult, AiOllamaStatusResult, AiPendingResult, AiPersonalitiesResult, AiPersonalityResult, AiProvidersResult, AiUsageResult, ChannelsResult } from './apiTypes'
export type ValleyPluginApi = HostApi & { assistant: AiDriver; channels: ChannelDriver }
const configurations = new WeakMap<object, { ready(): Promise<void>; dispose(): void }>()
export function assistantConfigurationReady(api: ValleyPluginApi): Promise<void> { return configurations.get(api)?.ready() ?? Promise.resolve() }
export function disposeAssistantConfiguration(api: ValleyPluginApi): void { configurations.get(api)?.dispose(); configurations.delete(api) }
export function createAssistantApi(api: HostApi): ValleyPluginApi {
  if ('assistant' in api && 'channels' in api) return api as ValleyPluginApi
  const driverCall = async (namespace: string, method: string, payload: unknown): Promise<DriverResult> => {
    try { return { ok: true, data: await api.backend.call(`${namespace}.${method}`, payload) } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }
  let settings: Record<string, unknown> = {}, live = true, revision: number | undefined, generation = 0
  let refresh: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const reload = (): Promise<void> => {
    if (refresh) return refresh
    const request = ++generation
    refresh = api.backend.call<SettingsDocument>('configuration.settings').then(value => {
      if (!live || request !== generation) return
      if (!Number.isSafeInteger(value?.revision) || value.revision < 0 || !value.values) throw new Error('Assistant settings could not be read')
      settings = value.values
      revision = value.revision
      for (const listener of listeners) listener()
    }).catch(error => { if (request === generation) revision = undefined; throw error }).finally(() => { refresh = undefined })
    return refresh
  }
  const offConfiguration = api.backend.on('configuration.changed', () => { void reload().catch(() => undefined) })
  const offFiles = api.data.files.onChanged(path => { if (path.endsWith('.md')) void reload().catch(() => undefined) })
  const offVault = api.vault.onChanged(() => { void reload().catch(() => undefined) })
  const ready = reload()
  void ready.catch(() => undefined)
  const result: ValleyPluginApi = { ...api,
      settings: { ...api.settings, get: () => ({ ...settings }), subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
        set: async (key, value) => {
          const expectedRevision = revision
          if (expectedRevision === undefined) throw new Error('Read the Assistant settings before changing them')
          const request = ++generation
          const saved = await api.backend.call<SettingsDocument>('configuration.set', { key, value, expectedRevision })
          if (live && request === generation) { settings = saved.values; revision = saved.revision; for (const listener of listeners) listener() }
          return { ok: true }
        } },
      assistant: {
        chat: (request) => driverCall('ai', 'chat', request) as Promise<AiChatStartResult>,
        cancel: (requestId) => driverCall('ai', 'cancel', { requestId }),
        listModels: (aiProvider) => driverCall('ai', 'listModels', { provider: aiProvider }) as Promise<AiModelsResult>,
        providerStatus: () => driverCall('ai', 'providerStatus', {}) as Promise<AiProvidersResult>,
        listConnections: () => driverCall('ai', 'listConnections', {}) as Promise<AiConnectionsResult>,
        getConfig: () => driverCall('ai', 'getConfig', {}) as Promise<AiConfigResult>,
        writeRule: (name, content, expectedRevision) => driverCall('ai', 'writeRule', { name, content, expectedRevision }),
        getGuard: () => driverCall('ai', 'getGuard', {}) as Promise<AiGuardResult>,
        appendGuardAudit: (entry) => driverCall('ai', 'appendGuardAudit', { entry }),
        addPending: (record) => driverCall('ai', 'addPending', { record }),
        removePending: (requestId) => driverCall('ai', 'removePending', { requestId }),
        listPending: () => driverCall('ai', 'listPending', {}) as Promise<AiPendingResult>,
        listChats: () => driverCall('ai', 'listChats', {}) as Promise<AiChatListResult>,
        readChat: (id) => driverCall('ai', 'readChat', { id }) as Promise<AiChatThreadResult>,
        saveChat: (thread) => driverCall('ai', 'saveChat', { thread }),
        renameChat: (id, title) => driverCall('ai', 'renameChat', { id, title }),
        deleteChat: (id) => driverCall('ai', 'deleteChat', { id }),
        clearChat: (id) => driverCall('ai', 'clearChat', { id }),
        setChatPinned: (id, pinned) => driverCall('ai', 'setChatPinned', { id, pinned }),
        readGuardOverrides: (chatId) => driverCall('ai', 'readGuardOverrides', { chatId }) as Promise<AiGuardOverridesResult>,
        saveGuardOverrides: (chatId, overrides) => driverCall('ai', 'saveGuardOverrides', { chatId, overrides }),
        listPersonalities: () => driverCall('ai', 'listPersonalities', {}) as Promise<AiPersonalitiesResult>,
        readPersonality: (id) => driverCall('ai', 'readPersonality', { id }) as Promise<AiPersonalityResult>,
        savePersonality: (personality) => driverCall('ai', 'savePersonality', { personality }),
        deletePersonality: (id, expectedRevision) => driverCall('ai', 'deletePersonality', { id, expectedRevision }),
        listCommands: () => driverCall('ai', 'listCommands', {}) as Promise<AiCommandsResult>,
        saveCommands: (commands, expectedRevisions) => driverCall('ai', 'saveCommands', { commands, expectedRevisions }),
        appendMemory: (chatId, entry) => driverCall('ai', 'appendMemory', { chatId, entry }),
        readMemory: (chatId) => driverCall('ai', 'readMemory', { chatId }) as Promise<AiMemoryResult>,
        onStream: (cb) => api.backend.on('stream', (payload) => cb(payload as AiStreamEvent)),
        ingestAttachment: (request) =>
          driverCall('ai', 'ingestAttachment', request) as Promise<DriverResult & { data?: { text: string } }>,
        listHarnesses: () => driverCall('ai', 'listHarnesses', {}) as Promise<AiHarnessesResult>,
        readHarnessPackage: (id) => driverCall('ai', 'readHarnessPackage', { id }) as Promise<AiHarnessPackageResult>,
        createHarness: (input) => driverCall('ai', 'createHarness', { package: input }) as Promise<AiHarnessesResult>,
        writeHarnessFile: (id, path, content, baseline) => driverCall('ai', 'writeHarnessFile', { id, path, content, baseline }) as Promise<import('@valley/plugin-sdk/types').GuardedWriteResult>,
        updateHarnessManifest: (id, manifest, baseline) => driverCall('ai', 'updateHarnessManifest', { id, manifest, baseline }) as Promise<import('@valley/plugin-sdk/types').GuardedWriteResult>,
        updateHarnessConfig: (id, config, baseline) => driverCall('ai', 'updateHarnessConfig', { id, config, baseline }) as Promise<import('@valley/plugin-sdk/types').GuardedWriteResult>,
        saveHarnessSettings: (id, values) => driverCall('ai', 'saveHarnessSettings', { id, values }) as Promise<AiHarnessesResult>,
        reloadHarnesses: () => driverCall('ai', 'reloadHarnesses', {}) as Promise<AiHarnessesResult>,
        runHarness: (id, targets, options) => driverCall('ai', 'runHarness', { id, targets, options }) as Promise<AiHarnessRunResult>,
        cancelHarnessRun: (runId) => driverCall('ai', 'cancelHarnessRun', { runId }),
        listHarnessRuns: (id, limit) => driverCall('ai', 'listHarnessRuns', { id, limit }) as Promise<AiHarnessRunsResult>,
        readHarnessRun: (runId) => driverCall('ai', 'readHarnessRun', { runId }) as Promise<AiHarnessRunResult>,
        clearHarnessCache: (id) => driverCall('ai', 'clearHarnessCache', { id }),
        onHarnessEvent: (cb) => api.backend.on('harness', (payload) => cb(payload as HarnessEvent))
      },
      channels: {
        list: () => driverCall('channels', 'list', {}) as Promise<ChannelsResult>,
        add: (type, name, expectedRevisions) =>
          driverCall('channels', 'add', { type, name, expectedRevisions }) as Promise<
            DriverResult & { data?: { id: string } & ChannelsInfo }
          >,
        remove: (channelId, expectedRevisions) => driverCall('channels', 'remove', { channelId, expectedRevisions }) as Promise<ChannelsResult>,
        rename: (channelId, name, expectedRevisions) => driverCall('channels', 'rename', { channelId, name, expectedRevisions }) as Promise<ChannelsResult>,
        setSecret: (channelId, secret) => driverCall('channels', 'setSecret', { channelId, secret }),
        setSecretField: (channelId, key, secret) => driverCall('channels', 'setSecretField', { channelId, key, secret }) as Promise<ChannelsResult>,
        setConfig: (channelId, config, expectedRevisions) => driverCall('channels', 'setConfig', { channelId, config, expectedRevisions }) as Promise<ChannelsResult>,
        start: (channelId, expectedRevisions) => driverCall('channels', 'start', { channelId, expectedRevisions }) as Promise<ChannelsResult>,
        stop: (channelId, expectedRevisions) => driverCall('channels', 'stop', { channelId, expectedRevisions }) as Promise<ChannelsResult>,
        send: (channelId, chatRef, text) => driverCall('channels', 'send', { channelId, chatRef, text }),
        sendButtons: (channelId, chatRef, text, buttons) =>
          driverCall('channels', 'sendButtons', { channelId, chatRef, text, buttons }),
        sendAttachment: (channelId, chatRef, path, caption) =>
          driverCall('channels', 'sendAttachment', { channelId, chatRef, path, caption }),
        onMessage: (cb) => api.backend.on('message', (payload) => cb(payload as ChannelMessage))
      }
  }
  configurations.set(result, { ready: () => refresh ?? (revision === undefined ? reload() : Promise.resolve()), dispose: () => { live = false; offConfiguration(); offVault(); offFiles(); listeners.clear() } })
  return result
}
