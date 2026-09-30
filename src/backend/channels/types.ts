/**
 * The pluggable remote-messaging contract. Telegram and WhatsApp implement the
 * same interface and register with the
 * `ChannelManager`. Adapters never touch the agent loop or driver events
 * directly — they push inbound messages through `ctx.onMessage`, and the manager
 * fans those out to the renderer over one channel-agnostic event.
 */
import type { ChannelMediaMetadata, ContactCard } from '../../contracts/channel'

export interface ChannelInboundMessage {
  questionId?: string
  chatType?: import('../../contracts/channel').MessageDestination['chatType']
  providerEventId?: string
  providerMessageId?: string
  senderId?: string
  topicId?: string
  replyToMessageId?: string
  callbackQueryId?: string
  callbackMessageId?: string
  receivedAt?: number
  contacts?: ContactCard[]
  location?: { latitude: number; longitude: number; name?: string; address?: string; livePeriod?: number }
  media?: InboundMediaSpec[]
  /** Opaque reference used to reply (e.g. a Telegram chat id or WhatsApp wa_id). */
  chatRef: string
  /** Display name / username of the sender, when known. */
  from?: string
  text: string
  /**
   * Callback payload from a tapped choice button (the `value` of a `sendButtons`
   * choice). Present instead of meaningful `text` for button clicks.
   */
  data?: string
  /** Files the user sent, already downloaded into the vault by the adapter. */
  attachments?: InboundAttachmentRef[]
}

/** A downloaded inbound file the adapter persisted into the vault. */
export interface InboundAttachmentRef {
  id?: string
  kind: 'image' | 'pdf' | 'audio' | 'file'
  /** Vault-relative path where the manager saved the file. */
  path: string
  fileName: string
  mime?: string
  metadata?: ChannelMediaMetadata
}
export interface InboundMediaSpec {
  provider: 'telegram' | 'whatsapp'
  mediaId: string
  kind: InboundAttachmentRef['kind']
  fileName: string
  mime?: string
  metadata: ChannelMediaMetadata
}
export interface ChannelLifecycleEvent {
  type: 'receipt' | 'reaction' | 'edited' | 'liveLocation' | 'unsupported'
  providerEventId: string
  chatRef: string
  providerMessageId: string
  state?: 'DELIVERED' | 'READ' | 'FAILED'
  emoji?: string
  text?: string
  error?: string
  location?: ChannelInboundMessage['location']
}

/** A file the adapter downloaded and hands to the manager to persist in the vault. */
export interface InboundDownload {
  bytes: Uint8Array
  fileName: string
  chatRef: string
  mime?: string
  kind?: InboundAttachmentRef['kind']
}

/** One tappable choice in a `sendButtons` prompt. */
export interface ChannelButton {
  label: string
  value: string
}

/** Non-secret adapter config passed to a running channel instance. */
export interface ChannelRuntimeConfig {
  attachment?: { fileName: string; mime: string; kind: string }
  type: string
  phoneNumberId?: string
  graphVersion?: string
  webhookPort?: number
  publicCallbackUrl?: string
}

export interface MessagingChannelContext {
  /** The channel's secret/token (resolved from safeStorage by the manager). */
  token: string
  /** Non-secret adapter config for this channel instance. */
  config?: ChannelRuntimeConfig
  /** Additional named encrypted secrets for adapters that need more than one token. */
  secrets?: Record<string, string | null>
  /** Allow-list of chat references; empty means accept none (safe default). */
  allowFrom: string[]
  onMessage: (msg: ChannelInboundMessage) => void | Promise<void>
  onLifecycle?: (event: ChannelLifecycleEvent) => void | Promise<void>
  ingest?: (msg: ChannelInboundMessage) => Promise<void>
  onError: (error: string) => void
  onConnectionChange?: () => void
  /**
   * Persist a file the adapter downloaded into the vault (the manager owns the
   * vault root + containment) and return its vault-relative path. Adapters that
   * receive inbound files call this before `onMessage` so the message can carry
   * vault paths, not raw bytes.
   */
  saveInbound: (download: InboundDownload) => Promise<{ id: string; path: string }>
}

export interface MessagingChannel {
  id: string
  /** Adapter kind this instance is built from (e.g. `'telegram'` or `'whatsapp'`). */
  type: string
  /** User-given display name for this connection instance. */
  displayName: string
  /** Whether this channel's poll/connection loop is currently running. */
  running: boolean
  connected?: boolean
  /** Last start/poll error, surfaced in the settings UI. */
  lastError?: string
  /** Begin the inbound loop (long-poll / socket). Idempotent if already running. */
  start(ctx: MessagingChannelContext): void
  /** Stop the loop. */
  stop(): void | Promise<void>
  /** Send an outbound message using an explicit token (manager resolves it). */
  send(token: string, chatRef: string, text: string, config?: ChannelRuntimeConfig): Promise<void>
  /**
   * Send a message with tappable choice buttons. Each button's `value` comes back
   * as `ChannelInboundMessage.data`. Optional — the manager falls back to `send`
   * with the choices appended as text for adapters that don't implement it.
   */
  sendButtons?(token: string, chatRef: string, text: string, buttons: ChannelButton[], config?: ChannelRuntimeConfig): Promise<void>
  /**
   * Send a local file of any type as an attachment with an optional caption.
   * `absPath` is an absolute on-disk path (the manager resolves the vault-relative
   * path and guarantees containment); the adapter picks the right transport by file
   * type (image / audio / video / document). Optional — the manager falls back to
   * `send` with the file name as text for adapters that don't implement it.
   */
  sendAttachment?(token: string, chatRef: string, absPath: string, caption?: string, config?: ChannelRuntimeConfig): Promise<void>
  /**
   * Register the bot's slash-commands with the platform so its native "/"
   * autocomplete menu lists them (e.g. Telegram's `setMyCommands`). Optional and
   * best-effort — a failure here must never block the channel's start/poll loop.
   */
  registerCommands?(token: string, commands: { command: string; description: string }[]): Promise<void>
}
