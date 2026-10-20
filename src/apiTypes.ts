import type { DriverResult, FileBaseline, GuardedWriteResult } from '@valley/plugin-sdk/types'
import type { HarnessId, AiChatRequest, AiChatSummary, AiChatThread, AiMemoryEntry, AiPersonality, AiModelInfo, AiOllamaStatus, AiProviderBalanceResult, AiConnectionStatus, AiProviderId, AiProvidersStatus, AiStreamEvent, AiUsageStats, AssistantConfig, ChannelMessage, ChannelsInfo, CustomCommand, RoutingConfig } from './types'
import type { GuardPolicy, GuardOverrides, GuardAuditEntry, PendingApprovalRecord } from '@valley/plugin-sdk/guard/types'
import type { HarnessPackageStatus, HarnessPackageSnapshot, HarnessRun, HarnessCreatePackage, HarnessManifest, HarnessConfig, HarnessSettingValue, HarnessTarget, HarnessRunOptions, HarnessEvent } from './harnessTypes'
export interface AiProvidersResult extends DriverResult {
  data?: AiProvidersStatus
}

/** `DriverResult` whose `data` carries every connected credential and its status.
 *  A provider may appear more than once — the connection is the unit, not the provider. */
export interface AiConnectionsResult extends DriverResult {
  data?: { connections: AiConnectionStatus[] }
}

/** `DriverResult` whose `data` carries a provider's model list. */
export interface AiModelsResult extends DriverResult {
  data?: { models: AiModelInfo[] }
}

/** `DriverResult` whose `data` carries the full `.valley/assistant` config. */
export interface AiConfigResult extends DriverResult {
  data?: AssistantConfig
}

/** `DriverResult` whose `data` carries the persisted Guard policy (`guards.json`). */
export interface AiGuardResult extends DriverResult {
  data?: { guard: GuardPolicy }
}

/** `DriverResult` whose `data` carries the persisted pending channel approvals. */
export interface AiPendingResult extends DriverResult {
  data?: { pending: PendingApprovalRecord[] }
}

/** `DriverResult` whose `data` carries a chat's persisted guard overrides (or null). */
export interface AiGuardOverridesResult extends DriverResult {
  data?: { overrides: GuardOverrides | null }
}

/** `DriverResult` whose `data` carries the started run's id. */
export interface AiChatStartResult extends DriverResult {
  data?: { requestId: string }
}

/** `DriverResult` whose `data` carries saved conversation summaries. */
export interface AiChatListResult extends DriverResult {
  data?: { chats: AiChatSummary[] }
}

/** `DriverResult` whose `data` carries one full conversation thread. */
export interface AiChatThreadResult extends DriverResult {
  data?: { thread: AiChatThread }
}

/** `DriverResult` whose `data` carries the assistant's personalities (profiles). */
export interface AiPersonalitiesResult extends DriverResult {
  data?: { personalities: AiPersonality[] }
}

/** `DriverResult` whose `data` carries one personality (null when not found). */
export interface AiPersonalityResult extends DriverResult {
  data?: { personality: AiPersonality | null }
}

/** `DriverResult` whose `data` carries the overall (all-chat) custom commands. */
export interface AiCommandsResult extends DriverResult {
  data?: { commands: CustomCommand[]; configurationRevisions: Record<string, number> }
}

/** `DriverResult` whose `data` carries a chat's extracted long-term memory. */
export interface AiMemoryResult extends DriverResult {
  data?: { memory: AiMemoryEntry[] }
}

/** `DriverResult` whose `data` carries the token/cost usage aggregates. */
export interface AiUsageResult extends DriverResult {
  data?: AiUsageStats
}

/** `DriverResult` whose `data` carries one provider's remaining balance (or null). */
export interface AiBalanceResult extends DriverResult {
  data?: AiProviderBalanceResult
}

/** `DriverResult` whose `data` carries the Ollama daemon status + installed models. */
export interface AiOllamaStatusResult extends DriverResult {
  data?: AiOllamaStatus
}

export interface AiHarnessesResult extends DriverResult {
  data?: { harnesses: HarnessPackageStatus[] }
}

export interface AiHarnessPackageResult extends DriverResult {
  data?: { package: HarnessPackageSnapshot | null }
}

export interface AiHarnessRunResult extends DriverResult {
  data?: { run: HarnessRun | null }
}

export interface AiHarnessRunsResult extends DriverResult {
  data?: { runs: HarnessRun[] }
}

/**
 * Multi-provider LLM capability. All network I/O and API keys live in the main
 * process; the renderer plugin starts a streamed run and subscribes via
 * `onStream` (chunks keyed by `requestId`). Keys are write-only — they are never
 * returned to the renderer. Also owns the `.valley/assistant/` config + chat
 * store so the "Orchestra" (rules, routing, and chats) has one legible home on
 * disk.
 */
export interface AiDriver {
  /** Start a streamed run; text/tool-calls arrive via `onStream` keyed by `requestId`. */
  chat(request: AiChatRequest): Promise<AiChatStartResult>
  /** Cancel an in-flight run by id. */
  cancel(requestId: string): Promise<DriverResult>
  /** List models for a provider (live discovery for Ollama; seeded list otherwise). */
  listModels(provider: AiProviderId): Promise<AiModelsResult>
  /** Per-provider configuration status (configured?/baseUrl/models) — never the key. */
  providerStatus(): Promise<AiProvidersResult>
  /**
   * Every connected credential with its status. A provider may hold any number of
   * connections; the provider's default connection carries the provider's own id,
   * which is why a `provider:model` ref still resolves.
   */
  listConnections(): Promise<AiConnectionsResult>
  /** Set (or clear, with `''`) one connection's API key — stored encrypted, write-only. */
  /** Set (or clear, with `''`) a provider's default-connection API key — encrypted, write-only. */
  /** Set a provider's base URL (Ollama / self-host / OpenAI-compatible gateway). */
  /** Read the aggregate Assistant config (default personality, rules, Guard, providers). */
  getConfig(): Promise<AiConfigResult>
  /** Create/overwrite a rule file `rules/<name>.md`. */
  writeRule(name: string, content: string, expectedRevision?: number): Promise<DriverResult>
  /** Read the Guard policy (`guards.json`) — the single permission rule set. */
  getGuard(): Promise<AiGuardResult>
  /** Append one decision to the guard audit trail (best-effort; never throws). */
  appendGuardAudit(entry: GuardAuditEntry): Promise<DriverResult>
  /** Persist a pending channel approval to runtime (survives restart, C8). */
  addPending(record: PendingApprovalRecord): Promise<DriverResult>
  /** Forget a pending channel approval (resolved/expired/recovered). */
  removePending(requestId: string): Promise<DriverResult>
  /** Every persisted pending approval — recovered on launch to expire dead waits. */
  listPending(): Promise<AiPendingResult>
  /** List saved conversation summaries (newest first). */
  listChats(): Promise<AiChatListResult>
  /** Read one full conversation thread. */
  readChat(id: string): Promise<AiChatThreadResult>
  /** Create/overwrite a conversation thread. */
  saveChat(thread: AiChatThread): Promise<DriverResult>
  /** Rename a conversation thread. */
  renameChat(id: string, title: string): Promise<DriverResult>
  /** Delete a conversation thread folder. */
  deleteChat(id: string): Promise<DriverResult>
  /** Wipe a chat's active context (`/clear`) but keep its `memory.jsonl`. */
  clearChat(id: string): Promise<DriverResult>
  /** Set the pinned flag on a conversation thread. */
  setChatPinned(id: string, pinned: boolean): Promise<DriverResult>
  /** Read a chat's persisted guard overrides (remembered approval choices). */
  readGuardOverrides(chatId: string): Promise<AiGuardOverridesResult>
  /** Persist a chat's guard overrides (narrow-only; the resolver clamps them). */
  saveGuardOverrides(chatId: string, overrides: GuardOverrides): Promise<DriverResult>
  /** List the assistant's personalities (profiles); the `default` sorts first. */
  listPersonalities(): Promise<AiPersonalitiesResult>
  /** Read one personality by id. */
  readPersonality(id: string): Promise<AiPersonalityResult>
  /** Create/overwrite a personality (claiming `isDefault` clears it on the rest). */
  savePersonality(personality: AiPersonality): Promise<DriverResult>
  /** Delete a personality (the `default` profile is never deletable). */
  deletePersonality(id: string, expectedRevision?: number): Promise<DriverResult>
  /** List the overall (all-chat) user-defined custom slash-commands. */
  listCommands(): Promise<AiCommandsResult>
  /** Replace the overall custom slash-commands (main re-normalizes the list). */
  saveCommands(commands: CustomCommand[], expectedRevisions?: Record<string, number>): Promise<DriverResult>
  /** Append one extracted fact to a chat's `memory.jsonl` (guard-checked in main). */
  appendMemory(chatId: string, entry: AiMemoryEntry): Promise<DriverResult>
  /** Read a chat's extracted long-term memory. */
  readMemory(chatId: string): Promise<AiMemoryResult>
  /** Subscribe to streamed run chunks; returns an unsubscribe fn. */
  onStream(cb: (event: AiStreamEvent) => void): () => void
  /** Token/cost usage aggregates (metered in main, stored encrypted outside the vault). */
  /**
   * Turn an inbound file into text the agent can act on. `parser` is `'markitdown'`
   * (Toolbox extraction/OCR) or a `'<provider>:<model>'` vision model; audio always
   * uses OpenAI Whisper. Returns the extracted/transcribed text.
   */
  ingestAttachment(request: {
    path: string
    kind: 'image' | 'pdf' | 'audio' | 'file'
    parser?: string
  }): Promise<DriverResult & { data?: { text: string } }>
  /** Live remaining balance for one provider (DeepSeek/Kimi expose one; others → null). */
  /** Ollama daemon reachability + installed models. */
  /** Safe API-metadata cache stats (Phase 5): hits + tokens/cost saved. */
  listHarnesses(): Promise<AiHarnessesResult>
  readHarnessPackage(id: string): Promise<AiHarnessPackageResult>
  createHarness(input: HarnessCreatePackage): Promise<AiHarnessesResult>
  writeHarnessFile(id: string, path: string, content: string, baseline: FileBaseline | null): Promise<GuardedWriteResult>
  updateHarnessManifest(id: string, manifest: HarnessManifest, baseline: FileBaseline | null): Promise<GuardedWriteResult>
  updateHarnessConfig(id: string, config: HarnessConfig, baseline: FileBaseline | null): Promise<GuardedWriteResult>
  saveHarnessSettings(id: string, values: Record<string, HarnessSettingValue>): Promise<AiHarnessesResult>
  reloadHarnesses(): Promise<AiHarnessesResult>
  runHarness(id: string, targets: HarnessTarget[], options?: HarnessRunOptions): Promise<AiHarnessRunResult>
  cancelHarnessRun(runId: string): Promise<DriverResult>
  listHarnessRuns(id: string, limit?: number): Promise<AiHarnessRunsResult>
  readHarnessRun(runId: string): Promise<AiHarnessRunResult>
  clearHarnessCache(id: string): Promise<DriverResult>
  onHarnessEvent(cb: (event: HarnessEvent) => void): () => void
}

/** `DriverResult` whose `data` carries the available channels + their status. */
export interface ChannelsResult extends DriverResult {
  data?: ChannelsInfo
}

/**
 * Pluggable remote-messaging capability (Telegram and official WhatsApp Cloud API).
 * Channel-agnostic: every adapter is reachable through the same methods, and
 * inbound messages arrive on one `onMessage` stream tagged with `channelId`.
 * Tokens are write-only (stored encrypted in main, never returned).
 */
export interface ChannelDriver {
  /** Available channel instances with non-secret status. */
  list(): Promise<ChannelsResult>
  /** Create a new channel instance of `type` (e.g. `'telegram'` or `'whatsapp'`) with a display name. */
  add(type: string, name: string, expectedRevisions?: Record<string, number>): Promise<DriverResult & { data?: { id: string } & ChannelsInfo }>
  /** Permanently remove a channel instance (stops it, clears its token + config). */
  remove(channelId: string, expectedRevisions?: Record<string, number>): Promise<ChannelsResult>
  /** Rename a channel instance's display name. */
  rename(channelId: string, name: string, expectedRevisions?: Record<string, number>): Promise<ChannelsResult>
  /** Set (or clear, with `''`) a channel's secret/token — stored encrypted. */
  setSecret(channelId: string, secret: string): Promise<DriverResult>
  /** Set (or clear, with `''`) a named adapter secret such as WhatsApp verify token/app secret. */
  setSecretField(channelId: string, key: 'verifyToken' | 'appSecret', secret: string): Promise<ChannelsResult>
  /**
   * Set a channel's non-secret config: the allow-list of chat refs plus the
   * connection-level defaults (`defaultProfile`/`defaultRouting`/`guard`). Pass
   * `null` for a default to clear it; omit a field to leave it unchanged.
   */
  setConfig(
    channelId: string,
    config: {
      name?: string
      allowFrom?: string[]
      defaultHarness?: HarnessId | null
      defaultProfile?: string | null
      defaultRouting?: RoutingConfig | null
      guard?: GuardOverrides | null
      commands?: CustomCommand[] | null
      /** Vault-relative path to a markdown system-prompt file (`null` clears it). */
      instructionsPath?: string | null
      /** Inbound-attachment parser for this connection (`null` clears it). */
      attachmentParser?: string | null
      phoneNumberId?: string | null
      graphVersion?: string | null
      webhookPort?: number | null
      publicCallbackUrl?: string | null
    },
    expectedRevisions?: Record<string, number>
  ): Promise<ChannelsResult>
  /** Start a channel's poll/connection loop. */
  start(channelId: string, expectedRevisions?: Record<string, number>): Promise<ChannelsResult>
  /** Stop a channel's loop. */
  stop(channelId: string, expectedRevisions?: Record<string, number>): Promise<ChannelsResult>
  /** Send an outbound message through a channel. */
  send(channelId: string, chatRef: string, text: string): Promise<DriverResult>
  /**
   * Send a message with tappable choice buttons (e.g. Telegram inline keyboard or WhatsApp interactive replies).
   * Each button's `value` comes back as a `ChannelMessage.data` callback when
   * tapped. Adapters without button support fall back to appending the choices
   * as text, so callers can always rely on a typed reply too.
   */
  sendButtons(channelId: string, chatRef: string, text: string, buttons: ChannelButton[]): Promise<DriverResult>
  /**
   * Send a vault file of any type (a vault-relative path) as an attachment through
   * a channel, with an optional caption. The adapter type-routes by file extension
   * (image / audio / video / document, e.g. Telegram sendPhoto/sendDocument or
   * WhatsApp Cloud API media messages). Adapters without attachment support fall back to a
   * text message naming the file. Returns `{ ok: false }` when the file is missing
   * or outside the vault.
   */
  sendAttachment(channelId: string, chatRef: string, path: string, caption?: string): Promise<DriverResult>
  /** Subscribe to inbound messages from every running channel; returns unsubscribe. */
  onMessage(cb: (message: ChannelMessage) => void): () => void
}

/** One tappable choice in a `sendButtons` prompt. */
export interface ChannelButton {
  /** Text shown on the button. */
  label: string
  /** Opaque value delivered back as `ChannelMessage.data` when tapped. */
  value: string
}
