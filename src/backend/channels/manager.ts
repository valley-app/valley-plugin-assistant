import { importAttachment, findAttachment } from '../attachments'
import { t, backendApi } from '../runtime'
import * as fs from '../filesystem'
import path from 'path-browserify'
import type { ChannelInfo, ChannelMessage, CustomCommand, RoutingConfig } from '../../types'
import type { GuardOverrides } from '@valley/plugin-sdk/guard/types'
import { capitalize } from '@valley/plugin-sdk/normalize'
import { emitDriverEvent } from '../runtime'
import { withBackgroundOperation } from '../runtime'
import { normalizeCommands } from '../commandConfig'
import { assistantDir } from '../paths'
import { channelKey, channelSecretKey, deleteSecret, getCredential, hasSecret, secretState } from '../secrets'
import { createTelegramChannel, openTelegramFile } from './telegram'
import { createWhatsAppChannel, openWhatsAppMedia, DEFAULT_WHATSAPP_GRAPH_VERSION, DEFAULT_WHATSAPP_WEBHOOK_PORT, whatsappLocalCallbackUrl } from './whatsapp'
import type { ChannelButton, ChannelInboundMessage, ChannelLifecycleEvent, ChannelRuntimeConfig, InboundDownload, MessagingChannel } from './types'
import type { MessageContent, MessageDestination } from '../../contracts/channel'
import { dispatchTelegram } from './adapters/telegram'
import { dispatchWhatsApp } from './adapters/whatsapp'
import { InboundMediaQueue } from './ingestionQueue'
import { ChannelActions, ChannelChoices, type ChannelActor, type PlanChannelAction } from './actions'
import type { AssistantRepository } from '../persistence/repositories'
import { readChannelConfigurations, writeChannelConfigurations } from '../configuration/channels'
import { effectiveSettings } from '../configuration/settings'
import { channelCapabilities } from './capabilities'
import { DeliveryRejected } from './deliveryQueue'
import type { ChannelDispatchAttachment } from './mediaProbe'

export interface ChannelRuntimeBinding {
  repository: AssistantRepository
  onInbound(channelId: string, message: ChannelInboundMessage): Promise<void>
  onLifecycle(channelId: string, event: ChannelLifecycleEvent): Promise<void>
  onAction?(channelId: string, action: PlanChannelAction, actor: ChannelActor): Promise<void>
}

/**
 * Registry + lifecycle for remote messaging channels. An adapter *type* (e.g.
 * `'telegram'`) registers one **factory**; the user can then create any number
 * of named **instances** of that type (each its own bot/connection with its own
 * token + allow-list). Adding a new adapter (e.g. WhatsApp) is a one-line
 * `registerFactory()`. The manager resolves tokens from safeStorage, persists
 * per-instance config (type + name + allow-list + enabled) in linked Markdown notes, auto-starts enabled instances
 * (`ensureStarted`, called by every driver method), and fans every inbound
 * message out over the channel-agnostic `channels`/`message` driver event.
 */
interface ChannelConfig {
  type: string
  name: string
  allowFrom: string[]
  enabled: boolean
  /** Default personality (profile) id for this connection's chats. */
  defaultProfile?: string
  /** Vault-relative path to a markdown system-prompt file used directly by this connection. */
  instructionsPath?: string
  /** Optional per-channel routing override (the `channel` layer in routing precedence). */
  defaultHarness?: import('../../types').HarnessId
  defaultRouting?: RoutingConfig
  /** Channel-level guard narrowing (the `channel` layer in the resolver — narrow-only). */
  guard?: GuardOverrides
  /** Custom slash-commands shared by every chat on this connection. */
  commands?: CustomCommand[]
  /** How inbound attachments are read for this connection (markitdown | provider:model). */
  attachmentParser?: string
  phoneNumberId?: string
  graphVersion?: string
  webhookPort?: number
  publicCallbackUrl?: string
}
type ChannelsFile = Record<string, ChannelConfig>

/** The non-secret per-channel config a caller may patch (allow-list + routing/guard defaults). */
export interface ChannelConfigPatch {
  defaultHarness?: import('../../types').HarnessId | null
  allowFrom?: string[]
  defaultProfile?: string | null
  instructionsPath?: string | null
  defaultRouting?: RoutingConfig | null
  guard?: GuardOverrides | null
  commands?: CustomCommand[] | null
  attachmentParser?: string | null
  phoneNumberId?: string | null
  graphVersion?: string | null
  webhookPort?: number | null
  publicCallbackUrl?: string | null
}

type ChannelFactory = (id: string, name: string) => MessagingChannel

function configPath(vaultRoot: string): string {
  return path.join(assistantDir(vaultRoot), 'channels.json')
}

function newInstanceId(type: string): string {
  return `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** The native "/" menu's command list — keep in sync with channelCommands.ts's
 *  `BUILTIN_COMMANDS`/`helpText()` (the renderer-side plugin package main can't import). */
const botCommands = (): { command: string; description: string }[] => [
  { command: 'help', description: t('assistant.backend.botHelp') },
  { command: 'clear', description: t('assistant.backend.botClear') },
  { command: 'model', description: t('assistant.backend.botModel') },
  { command: 'profile', description: t('assistant.backend.botProfile') },
  { command: 'guard', description: t('assistant.backend.botGuard') },
]

class ChannelManager {
  /** Adapter factories keyed by type — one per kind of channel. */
  private factories = new Map<string, ChannelFactory>()
  private endpointHosts = new Map<string, string[]>()
  /** Live channel instances keyed by instance id (rebuilt from config). */
  private instances = new Map<string, MessagingChannel>()
  private generation = 0
  private registrations = new Set<Promise<unknown>>()
  private runtime?: ChannelRuntimeBinding
  private mediaQueue?: InboundMediaQueue
  private actions?: ChannelActions

  bindRuntime(runtime: ChannelRuntimeBinding): void {
    if (this.mediaQueue) throw new Error('Channel runtime is already bound')
    this.runtime = runtime
    this.actions = new ChannelActions(runtime.repository)
    this.mediaQueue = new InboundMediaQueue(runtime.repository, {
      download: async (id, media, signal) => {
        const config = (await this.readConfig('/vault'))[id]
        if (!config?.enabled) throw new Error('Channel is disabled')
        const token = await this.credential('/vault', id)
        if (!token) throw new Error('Channel credential is unavailable')
        const maxBytes = Math.min((await effectiveSettings('/vault')).importMaxBytes, media.provider === 'telegram' ? 20 * 1024 * 1024 : channelCapabilities.whatsapp.media?.[media.metadata.media]?.maxBytes ?? 16 * 1024 * 1024)
        if (media.provider === 'telegram' && config.type === 'telegram') return { response: await openTelegramFile(token, media.mediaId, signal), fileName: media.fileName, mime: media.mime, maxBytes }
        if (media.provider === 'whatsapp' && config.type === 'whatsapp') return { ...await openWhatsAppMedia(token, config.graphVersion ?? DEFAULT_WHATSAPP_GRAPH_VERSION, media, signal), maxBytes }
        throw new Error('Media provider does not match the connection')
      },
      receive: async (id, message) => {
        const config = (await this.readConfig('/vault'))[id]
        if (!config?.enabled || !config.allowFrom.includes(message.chatRef)) throw new Error('Sender is no longer allowed')
        if (message.data?.startsWith('choice:')) {
          if (!message.senderId) throw new Error('Configuration choice has no authenticated sender')
          const accepted = await new ChannelChoices(runtime.repository).consume(message.data, { channelId: id, chatRef: message.chatRef, senderId: message.senderId, messageId: message.callbackMessageId }, (value, questionId) => runtime.onInbound(id, questionId ? { ...message, data: undefined, text: value, questionId } : { ...message, data: value }))
          if (!accepted) throw new Error('This choice expired or belongs to another sender or message')
          return
        }
        if (/^mdlp:|^mdls:/.test(message.data ?? '')) throw new Error('Unbound model choice rejected; use a current picker or /model')
        if (message.data?.startsWith('action:')) {
          if (!this.actions || !runtime.onAction || !message.senderId) throw new Error('Plan action handler is unavailable')
          const accepted = await this.actions.consume(message.data, { channelId: id, chatRef: message.chatRef, senderId: message.senderId, messageId: message.callbackMessageId }, (action, actor) => runtime.onAction!(id, action, actor))
          if (!accepted) throw new Error('This action has expired, was already used, or belongs to another conversation')
          return
        }
        await runtime.onInbound(id, message)
      },
      error: (id, error) => { const channel = this.instances.get(id); if (channel) channel.lastError = error; emitDriverEvent('channels', 'ingestion.failed', { channelId: id, error }); emitDriverEvent('channels', 'channels.changed', {}) }
    })
  }

  async recoverInbound(): Promise<void> { await this.mediaQueue?.recover() }
  async inboundJobs(channelId?: string) {
    if (!this.runtime) return []
    const jobs = await this.runtime.repository.rows<import('./ingestionQueue').InboundMediaJob>('inbound_media_jobs')
    return jobs.filter(job => !channelId || job.channelId === channelId).map(job => ({ id: job.id, channelId: job.channelId, chatRef: job.message.chatRef, providerMessageId: job.message.providerMessageId, state: job.state, attempts: job.attempts, error: job.error, receivedAt: job.message.receivedAt, media: job.message.media?.map(media => ({ fileName: media.fileName, media: media.metadata.media })) }))
  }
  async retryInbound(id: string): Promise<void> { if (!this.mediaQueue) throw new Error('Channel runtime is unavailable'); await this.mediaQueue.retry(id) }
  async createAction(action: PlanChannelAction, actor: ChannelActor): Promise<string> { if (!this.actions) throw new Error('Channel actions are unavailable'); return this.actions.issue(action, actor) }

  constructor() {
    this.registerFactory('telegram', (id, name) => createTelegramChannel(id, name), ['api.telegram.org'])
    this.registerFactory('whatsapp', (id, name) => createWhatsAppChannel(id, name), ['graph.facebook.com', 'lookaside.fbsbx.com'])
  }

  /** Register an adapter type so the user can create instances of it. */
  registerFactory(type: string, factory: ChannelFactory, hosts: string[]): void {
    this.factories.set(type, factory)
    this.endpointHosts.set(type, [...hosts])
  }

  private async readLegacyConfig(vaultRoot: string): Promise<ChannelsFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(configPath(vaultRoot), 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const file: ChannelsFile = {}
      for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        const entry = raw as Partial<ChannelConfig>
        if (typeof entry.type !== 'string' || typeof entry.name !== 'string') continue
        file[id] = {
          type: entry.type,
          name: entry.name,
          allowFrom: Array.isArray(entry.allowFrom) ? entry.allowFrom : [],
          enabled: Boolean(entry.enabled),
          ...(entry.defaultProfile != null ? { defaultProfile: entry.defaultProfile } : {}),
          ...(entry.instructionsPath != null ? { instructionsPath: entry.instructionsPath } : {}),
          ...(entry.defaultHarness ? { defaultHarness: entry.defaultHarness } : {}),
          ...(entry.defaultRouting != null ? { defaultRouting: entry.defaultRouting } : {}),
          ...(entry.guard != null ? { guard: entry.guard } : {}),
          ...(entry.commands != null ? { commands: entry.commands } : {}),
          ...(entry.attachmentParser != null ? { attachmentParser: entry.attachmentParser } : {}),
          ...(entry.phoneNumberId != null ? { phoneNumberId: entry.phoneNumberId } : {}),
          ...(entry.graphVersion != null ? { graphVersion: entry.graphVersion } : {}),
          ...(typeof entry.webhookPort === 'number' ? { webhookPort: entry.webhookPort } : {}),
          ...(entry.publicCallbackUrl != null ? { publicCallbackUrl: entry.publicCallbackUrl } : {})
        }
      }
      return file
    } catch {
      return {}
    }
  }

  private async readConfig(vaultRoot: string): Promise<ChannelsFile> {
    return readChannelConfigurations(vaultRoot, await this.readLegacyConfig(vaultRoot))
  }

  private runtimeConfig(cfg: ChannelConfig): ChannelRuntimeConfig {
    return {
      type: cfg.type,
      ...(cfg.phoneNumberId ? { phoneNumberId: cfg.phoneNumberId } : {}),
      ...(cfg.graphVersion ? { graphVersion: cfg.graphVersion } : cfg.type === 'whatsapp' ? { graphVersion: DEFAULT_WHATSAPP_GRAPH_VERSION } : {}),
      ...(cfg.webhookPort ? { webhookPort: cfg.webhookPort } : cfg.type === 'whatsapp' ? { webhookPort: DEFAULT_WHATSAPP_WEBHOOK_PORT } : {}),
      ...(cfg.publicCallbackUrl ? { publicCallbackUrl: cfg.publicCallbackUrl } : {})
    }
  }

  async credential(vaultRoot: string, id: string, name?: string): Promise<string | null> {
    const config = (await this.readConfig(vaultRoot))[id]
    if (!config) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    return getCredential(vaultRoot, name ? channelSecretKey(id, name) : channelKey(id), this.endpoints(config.type))
  }
  endpoints(type: string): Array<{ host: string; port: number; security: 'tls' }> {
    const hosts = this.endpointHosts.get(type) ?? []
    if (!hosts.length) throw new Error(t('assistant.backend.unknownChannelType', { value: type }))
    return hosts.map((host) => ({ host, port: 443, security: 'tls' }))
  }
  async credentialEndpoints(vaultRoot: string, id: string) {
    const config = (await this.readConfig(vaultRoot))[id]
    if (!config) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    return this.endpoints(config.type)
  }

  private async channelSecrets(vaultRoot: string, id: string, cfg: ChannelConfig): Promise<Record<string, string | null>> {
    if (cfg.type !== 'whatsapp') return {}
    return {
      verifyToken: await this.credential(vaultRoot, id, 'verifyToken'),
      appSecret: await this.credential(vaultRoot, id, 'appSecret')
    }
  }

  private async isConfigured(vaultRoot: string, id: string, cfg: ChannelConfig): Promise<boolean> {
    const hasToken = await hasSecret(vaultRoot, channelKey(id))
    if (cfg.type !== 'whatsapp') return hasToken
    return Boolean(
      hasToken &&
      cfg.phoneNumberId?.trim() &&
      await hasSecret(vaultRoot, channelSecretKey(id, 'verifyToken')) &&
      await hasSecret(vaultRoot, channelSecretKey(id, 'appSecret'))
    )
  }

  private async writeConfig(vaultRoot: string, file: ChannelsFile): Promise<void> {
    await writeChannelConfigurations(vaultRoot, file)
  }

  /**
   * Sync the live instance map to the persisted config: create a channel object
   * for every configured instance whose type has a factory, drop instances no
   * longer in config (stopping them first), and keep display names in step.
   */
  private async ensureInstances(vaultRoot: string): Promise<ChannelsFile> {
    const version = this.generation
    const file = await this.readConfig(vaultRoot)
    if (version !== this.generation) return {}
    for (const [id, cfg] of Object.entries(file)) {
      const factory = this.factories.get(cfg.type)
      if (!factory) continue
      const existing = this.instances.get(id)
      if (!existing) this.instances.set(id, factory(id, cfg.name))
      else existing.displayName = cfg.name
    }
    for (const [id, channel] of this.instances) {
      if (!file[id]) {
        await channel.stop()
        this.instances.delete(id)
      }
    }
    return file
  }

  /** Start every enabled instance that has a token and isn't already running. */
  async ensureStarted(vaultRoot: string): Promise<void> {
    const version = this.generation
    const file = await this.ensureInstances(vaultRoot)
    for (const [id, channel] of this.instances) {
      const cfg = file[id]
      if (cfg?.enabled && !channel.running) {
        const token = await this.credential(vaultRoot, id)
        if (token && await this.isConfigured(vaultRoot, id, cfg)) await this.startChannel(vaultRoot, channel, token, cfg, version)
      }
    }
  }

  private async startChannel(vaultRoot: string, channel: MessagingChannel, token: string, cfg: ChannelConfig, version: number): Promise<void> {
    const owner = backendApi()
    const secrets = await this.channelSecrets(vaultRoot, channel.id, cfg)
    const current = (): boolean => version === this.generation && backendApi() === owner && this.instances.get(channel.id) === channel
    if (!current()) return
    channel.start({
      token,
      config: this.runtimeConfig(cfg),
      secrets,
      allowFrom: cfg.allowFrom,
      ...(this.mediaQueue ? { ingest: async (msg: ChannelInboundMessage) => { if (!current()) throw new Error('Channel session is no longer active'); await this.mediaQueue!.accept(channel.id, msg) } } : {}),
      onLifecycle: async event => {
        if (!current()) throw new Error('Channel session is no longer active')
        if (this.runtime) await this.runtime.onLifecycle(channel.id, event)
        emitDriverEvent('channels', 'lifecycle', { channelId: channel.id, ...event })
      },
      onMessage: (msg) => {
        if (!current()) return
        emitDriverEvent('channels', 'message', {
          channelId: channel.id,
          chatRef: msg.chatRef,
          from: msg.from,
          text: msg.text,
          data: msg.data,
          providerEventId: msg.providerEventId,
          providerMessageId: msg.providerMessageId,
          senderId: msg.senderId,
          topicId: msg.topicId,
          ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
          ts: Date.now()
        } satisfies ChannelMessage)
      },
      onConnectionChange: () => {
        if (current()) emitDriverEvent('channels', 'channels.changed', {})
      },
      onError: (error) => {
        if (!current()) return
        channel.lastError = error
        emitDriverEvent('channels', 'channels.changed', {})
        console.error(`[assistant:channel:${channel.id}]`, error)
      },
      saveInbound: (download) => {
        if (!current()) return Promise.reject(new Error('Channel session is no longer active'))
        return withBackgroundOperation(vaultRoot, () => this.saveInbound(vaultRoot, channel.id, download))
      }
    })
    const registration = channel.registerCommands?.(token, botCommands())
    if (registration) {
      this.registrations.add(registration)
      void registration.then(() => this.registrations.delete(registration), error => { this.registrations.delete(registration); if (current()) channel.lastError = error instanceof Error ? error.message : String(error) })
    }
  }

  private async saveInbound(_root: string, _channelId: string, download: InboundDownload): Promise<{ id: string; path: string }> {
    const attachment = await importAttachment({ bytes: download.bytes, fileName: download.fileName, kind: download.kind ?? 'file', mime: download.mime })
    return { id: attachment.id!, path: attachment.path }
  }

  async list(vaultRoot: string): Promise<ChannelInfo[]> {
    await this.ensureStarted(vaultRoot)
    const file = await this.readConfig(vaultRoot)
    const out: ChannelInfo[] = []
    for (const [id, channel] of this.instances) {
      const cfg = file[id]
      out.push({
        id,
        type: channel.type,
        name: channel.displayName,
        displayName: channel.displayName,
        configured: cfg ? await this.isConfigured(vaultRoot, id, cfg) : false,
        running: channel.running,
        connected: Boolean(channel.running && channel.connected && !channel.lastError),
        allowFrom: cfg?.allowFrom ?? [],
        ...(cfg?.defaultProfile ? { defaultProfile: cfg.defaultProfile } : {}),
        ...(cfg?.instructionsPath ? { instructionsPath: cfg.instructionsPath } : {}),
        ...(cfg?.defaultHarness ? { defaultHarness: cfg.defaultHarness } : {}),
        ...(cfg?.defaultRouting ? { defaultRouting: cfg.defaultRouting } : {}),
        ...(cfg?.guard ? { guard: cfg.guard } : {}),
        ...(cfg?.commands?.length ? { commands: cfg.commands } : {}),
        ...(cfg?.attachmentParser ? { attachmentParser: cfg.attachmentParser } : {}),
        ...(cfg?.phoneNumberId ? { phoneNumberId: cfg.phoneNumberId } : {}),
        ...(cfg?.type === 'whatsapp' ? { graphVersion: cfg.graphVersion ?? DEFAULT_WHATSAPP_GRAPH_VERSION } : {}),
        ...(cfg?.type === 'whatsapp' ? { webhookPort: cfg.webhookPort ?? DEFAULT_WHATSAPP_WEBHOOK_PORT } : {}),
        ...(cfg?.publicCallbackUrl ? { publicCallbackUrl: cfg.publicCallbackUrl } : {}),
        ...(cfg?.type === 'whatsapp' ? { webhookLocalUrl: whatsappLocalCallbackUrl(id, cfg.webhookPort ?? DEFAULT_WHATSAPP_WEBHOOK_PORT) } : {}),
        error: channel.lastError
      })
    }
    return out
  }

  /** Create a new instance of `type` with a display name; returns its id. */
  async add(vaultRoot: string, type: string, name: string): Promise<string> {
    if (!this.factories.has(type)) throw new Error(t('assistant.backend.unknownChannelType', { value: type }))
    const id = newInstanceId(type)
    const file = await this.readConfig(vaultRoot)
    file[id] = {
      type,
      name: name.trim() || capitalize(type),
      allowFrom: [],
      enabled: false,
      ...(type === 'whatsapp' ? { graphVersion: DEFAULT_WHATSAPP_GRAPH_VERSION, webhookPort: DEFAULT_WHATSAPP_WEBHOOK_PORT } : {})
    }
    await this.writeConfig(vaultRoot, file)
    await this.ensureInstances(vaultRoot)
    return id
  }

  /** Permanently remove an instance: stop it, drop its config entry + token. */
  async remove(vaultRoot: string, id: string): Promise<void> {
    this.instances.get(id)?.stop()
    this.instances.delete(id)
    const file = await this.readConfig(vaultRoot)
    if (file[id]) {
      delete file[id]
      await this.writeConfig(vaultRoot, file)
    }
    await deleteSecret(vaultRoot, channelKey(id))
    await deleteSecret(vaultRoot, channelSecretKey(id, 'verifyToken'))
    await deleteSecret(vaultRoot, channelSecretKey(id, 'appSecret'))
  }

  /** Rename an instance's display name. */
  async rename(vaultRoot: string, id: string, name: string): Promise<void> {
    const file = await this.readConfig(vaultRoot)
    const cfg = file[id]
    if (!cfg) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    cfg.name = name.trim() || cfg.name
    await this.writeConfig(vaultRoot, file)
    const instance = this.instances.get(id)
    if (instance) instance.displayName = cfg.name
  }

  async setConfig(vaultRoot: string, id: string, patch: ChannelConfigPatch): Promise<void> {
    const version = this.generation
    await this.ensureInstances(vaultRoot)
    const channel = this.instances.get(id)
    if (!channel) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    const file = await this.readConfig(vaultRoot)
    const cfg = file[id]
    if (patch.allowFrom) cfg.allowFrom = patch.allowFrom
    // `null` clears the default; `undefined` leaves it unchanged (partial patch).
    if (patch.defaultProfile !== undefined) cfg.defaultProfile = patch.defaultProfile ?? undefined
    if (patch.instructionsPath !== undefined) cfg.instructionsPath = patch.instructionsPath?.trim() ?? ''
    if (patch.defaultHarness !== undefined) cfg.defaultHarness = patch.defaultHarness ?? undefined
    if (patch.defaultRouting !== undefined) cfg.defaultRouting = patch.defaultRouting ?? undefined
    if (patch.guard !== undefined) cfg.guard = patch.guard ?? undefined
    if (patch.commands !== undefined) {
      const next = patch.commands ? normalizeCommands(patch.commands) : []
      cfg.commands = next.length ? next : undefined
    }
    if (patch.attachmentParser !== undefined) cfg.attachmentParser = patch.attachmentParser?.trim() || undefined
    if (patch.phoneNumberId !== undefined) cfg.phoneNumberId = patch.phoneNumberId?.trim() || undefined
    if (patch.graphVersion !== undefined) cfg.graphVersion = patch.graphVersion?.trim() || undefined
    if (patch.webhookPort !== undefined) cfg.webhookPort = patch.webhookPort ?? undefined
    if (patch.publicCallbackUrl !== undefined) cfg.publicCallbackUrl = patch.publicCallbackUrl?.trim() || undefined
    file[id] = cfg
    await this.writeConfig(vaultRoot, file)
    if (channel.running) {
      // Restart with the new config.
      const token = await this.credential(vaultRoot, id)
      await channel.stop()
      if (token && cfg.enabled && await this.isConfigured(vaultRoot, id, cfg)) await this.startChannel(vaultRoot, channel, token, cfg, version)
    }
  }

  async start(vaultRoot: string, id: string): Promise<void> {
    const version = this.generation
    await this.ensureInstances(vaultRoot)
    const channel = this.instances.get(id)
    if (!channel) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    const token = await this.credential(vaultRoot, id)
    if (!token) throw new Error(t('assistant.backend.missingToken', { value: channel.displayName }))
    const file = await this.readConfig(vaultRoot)
    const cfg = file[id]
    if (!await this.isConfigured(vaultRoot, id, cfg)) throw new Error(t('assistant.backend.missingConfiguration', { value: channel.displayName }))
    cfg.enabled = true
    file[id] = cfg
    await this.writeConfig(vaultRoot, file)
    if (!channel.running) await this.startChannel(vaultRoot, channel, token, cfg, version)
  }

  async stopAll(): Promise<void> {
    this.generation++
    const ingestion = this.mediaQueue?.stop()
    this.mediaQueue = undefined; this.runtime = undefined; this.actions = undefined
    const stopped = [...this.instances.values()].map(channel => channel.stop())
    const results = await Promise.allSettled([...stopped, ...this.registrations, ingestion])
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }

  async stop(vaultRoot: string, id: string): Promise<void> {
    await this.ensureInstances(vaultRoot)
    const channel = this.instances.get(id)
    if (!channel) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    const file = await this.readConfig(vaultRoot)
    const cfg = file[id]
    cfg.enabled = false
    file[id] = cfg
    await this.writeConfig(vaultRoot, file)
    await channel.stop()
  }

  /** Re-evaluate an instance after its token changed (driver setSecret). */
  async refresh(vaultRoot: string, id: string): Promise<void> {
    const version = this.generation
    await this.ensureInstances(vaultRoot)
    const channel = this.instances.get(id)
    if (!channel) return
    const file = await this.readConfig(vaultRoot)
    const cfg = file[id]
    const token = await this.credential(vaultRoot, id)
    await channel.stop()
    if (cfg?.enabled && token && await this.isConfigured(vaultRoot, id, cfg)) await this.startChannel(vaultRoot, channel, token, cfg, version)
  }

  async send(vaultRoot: string, id: string, chatRef: string, text: string): Promise<void> {
    await this.ensureInstances(vaultRoot)
    const channel = this.instances.get(id)
    if (!channel) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    const file = await this.readConfig(vaultRoot)
    const cfg = file[id]
    if (!cfg) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    const token = await this.credential(vaultRoot, id)
    if (!token) throw new Error(t('assistant.backend.missingToken', { value: channel.displayName }))
    try {
      await channel.send(token, chatRef, text, this.runtimeConfig(cfg))
    } catch (error) {
      channel.connected = false
      channel.lastError = error instanceof Error ? error.message : String(error)
      emitDriverEvent('channels', 'channels.changed', {})
      throw error
    }
  }

  async dispatch(destination: MessageDestination, content: MessageContent, attachment?: ChannelDispatchAttachment): Promise<string[]> {
    const { channelId, chatRef } = destination
    if (!channelId || !chatRef) throw new DeliveryRejected('A channel and recipient are required')
    const cfg = (await this.readConfig('/vault'))[channelId]
    if (!cfg || !cfg.enabled || cfg.type !== destination.kind || !cfg.allowFrom.map(value => value.trim()).includes(chatRef)) throw new DeliveryRejected('Destination is not explicitly allowed for this connection')
    const token = await this.credential('/vault', channelId)
    if (!token) throw new DeliveryRejected('The channel has no configured credential')
    if (cfg.type === 'telegram') return dispatchTelegram(token, destination, content, attachment)
    if (cfg.type === 'whatsapp') return dispatchWhatsApp(token, this.runtimeConfig(cfg), destination, content, attachment)
    throw new DeliveryRejected('Unsupported channel')
  }

  async operationDescriptors(root: string, destination: MessageDestination) {
    const protocol = channelCapabilities[destination.kind]
    const config = destination.channelId ? (await this.readConfig(root))[destination.channelId] : undefined
    let reason = !config || config.type !== destination.kind ? 'Channel connection is unavailable' : !config.enabled ? 'Channel connection is disabled' : !destination.chatRef || !config.allowFrom.map(value => value.trim()).includes(destination.chatRef) ? 'Recipient is not allowed for this connection' : undefined
    if (!reason && await secretState(root, channelKey(destination.channelId!)) !== 'ok') reason = 'Channel credential is missing or unreadable'
    if (!reason && destination.kind === 'whatsapp' && !config?.phoneNumberId) reason = 'WhatsApp phone number is not configured'
    const applicationMaxBytes = (await effectiveSettings(root)).importMaxBytes
    const receipts = destination.kind === 'whatsapp' && this.runtime ? await this.runtime.repository.rows<{ receivedAt: number }>('inbound_receipts', { conversationId: destination.conversationId }) : []
    const windowOpen = destination.kind !== 'whatsapp' || receipts.some(receipt => receipt.receivedAt > Date.now() - 24 * 60 * 60 * 1000)
    const types = [...new Set(Object.values(channelCapabilities).flatMap(value => value.kinds))]
    return {
      ...protocol, available: !reason, reason, applicationMaxBytes,
      transport: destination.kind === 'telegram' ? 'cloud-bot-api' : destination.kind === 'whatsapp' ? 'cloud-api' : 'local',
      ...(destination.kind === 'telegram' ? { keyboardVariants: { webApp: { available: !reason && destination.chatType === 'private', reason: reason ?? (destination.chatType === 'private' ? undefined : 'Web App buttons require a provider-verified private chat') }, reply: { available: !reason && Boolean(destination.chatType && destination.chatType !== 'channel'), reason: reason ?? (!destination.chatType ? 'The provider chat type is unknown' : destination.chatType === 'channel' ? 'Reply keyboards are unavailable in channels' : undefined) } } } : {}),
      inboundDownloadMaxBytes: destination.kind === 'telegram' ? Math.min(applicationMaxBytes, 20 * 1024 * 1024) : applicationMaxBytes,
      media: Object.fromEntries(Object.entries(protocol.media ?? {}).map(([kind, limits]) => [kind, { ...limits, effectiveMaxBytes: Math.min(applicationMaxBytes, limits.maxBytes) }])),
      operations: types.map(type => {
        const unsupported = !protocol.kinds.includes(type)
        const unavailable = unsupported ? protocol.unavailable?.[type] ?? `${destination.kind} does not support ${type}` : reason ?? (!windowOpen && !['template', 'read'].includes(type) ? 'The WhatsApp support window is closed; use an approved template' : undefined)
        return { type, supported: !unsupported, available: !unavailable, reason: unavailable, ...(destination.kind === 'telegram' && type === 'pin' ? { requirement: 'Telegram administrator rights in the destination chat' } : {}) }
      })
    }
  }

  /**
   * Send a message with choice buttons. Adapters that don't implement
   * `sendButtons` fall back to a plain message listing the choices, so a typed
   * reply still works everywhere.
   */
  async sendButtons(
    vaultRoot: string,
    id: string,
    chatRef: string,
    text: string,
    buttons: ChannelButton[]
  ): Promise<void> {
    await this.ensureInstances(vaultRoot)
    const channel = this.instances.get(id)
    if (!channel) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    const file = await this.readConfig(vaultRoot)
    const cfg = file[id]
    if (!cfg) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    const token = await this.credential(vaultRoot, id)
    if (!token) throw new Error(t('assistant.backend.missingToken', { value: channel.displayName }))
    if (channel.sendButtons) {
      await channel.sendButtons(token, chatRef, text, buttons, this.runtimeConfig(cfg))
    } else {
      const hint = buttons.map((b) => `"${b.value}"`).join(' / ')
      await channel.send(token, chatRef, `${text}\nReply ${hint}.`)
    }
  }

  /**
   * Send a vault file of any type as an attachment. `filePath` is vault-relative; it
   * is resolved against the vault root and must stay inside it (no `..`/absolute
   * escape). The adapter picks the transport by file type. Adapters without
   * `sendAttachment` fall back to a text message naming the file, so the flow never
   * breaks silently.
   */
  async sendAttachment(vaultRoot: string, id: string, chatRef: string, filePath: string, caption?: string): Promise<void> {
    await this.ensureInstances(vaultRoot)
    const channel = this.instances.get(id)
    if (!channel) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    const file = await this.readConfig(vaultRoot)
    const cfg = file[id]
    if (!cfg) throw new Error(t('assistant.backend.unknownChannel', { value: id }))
    const token = await this.credential(vaultRoot, id)
    if (!token) throw new Error(t('assistant.backend.missingToken', { value: channel.displayName }))
    const root = path.resolve(vaultRoot)
    const abs = path.resolve(root, filePath)
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(t('assistant.backend.outsideVault'))
    if (channel.sendAttachment) {
      const attachment = await findAttachment(filePath)
      await channel.sendAttachment(token, chatRef, abs, caption, { ...this.runtimeConfig(cfg), ...(attachment ? { attachment: { fileName: attachment.fileName, mime: attachment.mime, kind: attachment.kind } } : {}) })
    } else {
      throw new Error('This channel does not support file attachments')
    }
  }
}

/** Singleton — channel poll loops are process-global and outlive any one call. */
export const channelManager = new ChannelManager()
