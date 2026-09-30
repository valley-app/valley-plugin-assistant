import { listConnections, readGuardPolicy, appendGuardAudit } from './exports'
import { t } from './runtime'
import { z } from 'zod'
import { startRun, cancelRun } from './exports'
import { appendMemory, clearChat, deleteChat, deletePersonality, listChats, listPersonalities, readChat, readCommands, readConfig, readGuardOverrides, readMemory, readPersonality, renameChat, saveChat, saveCommands, saveGuardOverrides, savePersonality, setChatPinned, writeRule } from './exports'
import { ingestAttachment } from './exports'
import { addPending, listPending, removePending } from './exports'
import { backendApi } from './runtime'
import type { GuardAuditEntry } from '@valley/plugin-sdk/guard/types'
import { defineDriver, defineDriverMethod } from './contract'
import { createHarnessPackage, ensureHarnessPackages, listHarnessPackageStatuses, readHarnessPackage, reloadHarnessPackages, saveHarnessSettings, writeHarnessFile } from './exports'
import { clearHarnessCache } from './exports'
import { cancelHarnessRun, listHarnessRuns, readHarnessRun, startHarnessRun } from './exports'
import type { HarnessConfig, HarnessCreatePackage, HarnessManifest, HarnessSettingValue } from '../harnessTypes'

/** Cache TTLs — model lists rarely change; balances move with spend; completions are deterministic. */

/**
 * Main-process AI capability behind the assistant plugin: starts streamed runs
 * (tokens/tool-calls flow back via `ai`/`stream` driver events), discovers
 * models, manages encrypted provider keys, and owns the `.valley/assistant`
 * config + chat store. Keys are write-only — never returned to the renderer.
 */
const provider = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)

const aiMessage = z.object({
  ingestionState: z.enum(['pending', 'complete']).optional(),
  voiceInput: z.boolean().optional(),
  channelDeliveryId: z.string().max(1024).optional(),
  id: z.string().optional(),
  continuation: z.object({ provider: z.string().min(1).max(64), model: z.string().min(1).max(512), reasoningContent: z.string().max(4 * 1024 * 1024) }).strict().optional(),
  displayContent: z.string().optional(),
  attachmentFiles: z.array(z.object({ fileName: z.string(), path: z.string(), kind: z.string(), warning: z.boolean().optional(), mime: z.string().optional(), metadata: z.custom<import('../contracts/channel').ChannelMediaMetadata>().optional() })).optional(),
  error: z.boolean().optional(),
  activityRunId: z.string().max(256).optional(),
  attachmentIds: z.array(z.string().uuid()).optional(),
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  toolCalls: z
    .array(z.object({ id: z.string(), name: z.string(), arguments: z.record(z.unknown()) }))
    .optional(),
  toolCallId: z.string().optional(),
  name: z.string().optional(),
  render: z.enum(['quiz-image']).optional(),
  ts: z.number().optional(),
  attachments: z.array(z.object({ mime: z.string(), dataBase64: z.string() })).optional()
})

const quizPrompt = z.object({
  source: z.string(),
  choices: z.array(z.object({ value: z.string(), label: z.string() })),
  imagePath: z.string().optional()
})

/** A connection id is a file-safe slug — it keys a secret and a cache entry. */
const connectionId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
const harnessId = provider
const harnessTarget = z.object({ provider, connectionId: connectionId.optional(), model: z.string().min(1) }).strict()
const harnessBaseline = z.object({ mtimeMs: z.number(), size: z.number(), hash: z.string() }).strict().nullable()

const guardAuditEntry: z.ZodType<GuardAuditEntry> = z.object({
  ts: z.number(),
  caller: z.enum(['palette', 'hotkey', 'agent', 'channel', 'plugin']),
  decision: z.enum(['allow', 'confirm', 'deny', 'bypass', 'expired', 'skipped']),
  source: z.enum(['hard-block', 'global-guard', 'profile', 'channel', 'chat', 'dangerous-mode', 'caller']),
  reason: z.string(),
  targetKind: z.enum(['tool', 'command', 'file']),
  targetId: z.string().optional(),
  path: z.string().optional(),
  fileOperation: z.enum(['list', 'search', 'open', 'read', 'create', 'write', 'delete']).optional(),
  pluginId: z.string().optional(),
  channelId: z.string().optional(),
  chatId: z.string().optional()
})

const chatRequest = z.object({
  requestId: z.string().min(1),
  provider,
  connectionId: connectionId.optional(),
  model: z.string().min(1),
  messages: z.array(aiMessage),
  tools: z
    .array(z.object({ name: z.string(), description: z.string(), parameters: z.record(z.unknown()) }))
    .optional(),
  web: z.boolean().optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  baseUrl: z.string().optional(),
  origin: z.enum(['ui', 'channel']).optional(),
  conversationId: z.string().optional()
})

const modelRef = z.object({ provider, model: z.string(), connectionId: connectionId.optional() })

const routingConfig = z.object({
  auto: z.boolean(),
  default: modelRef,
  fast: modelRef.optional(),
  rules: z.array(
    z.object({
      label: z.string().optional(),
      match: z.array(z.string()).optional(),
      kind: z.string().optional(),
      minComplexity: z.number().optional(),
      provider,
      model: z.string(),
      connectionId: connectionId.optional()
    })
  )
})

/** A user-defined slash-command (prompt macro); main re-normalizes on save. */
const customCommand = z.object({
  name: z.string(),
  description: z.string().optional(),
  prompt: z.string()
})

const permission = z.enum(['allow', 'confirm', 'deny'])
const guardEntry = z.object({ decision: permission, allowPreApproval: z.boolean().optional() })
/** A per-chat/channel narrowing set (narrow-only — the resolver clamps it). */
const guardOverrides = z.object({
  tools: z.record(guardEntry).optional(),
  commands: z.record(guardEntry).optional(),
  fileReadOverrides: z.record(guardEntry).optional(),
  fileWriteOverrides: z.record(guardEntry).optional(),
  blocked: z.array(z.string()).optional()
})

export const chatThread = z.object({
  channelSenderId: z.string().optional(),
  channelTopicId: z.string().optional(),
  channelChatType: z.enum(['private', 'group', 'supergroup', 'channel']).optional(),
  configurationHash: z.string().optional(),
  titleOrigin: z.enum(['manual', 'generated', 'fallback']).optional(),
  titleRevision: z.number().int().nonnegative().optional(),
  instructionsPath: z.string().optional(),
  mode: z.enum(['plan','execute']).optional(),
  plan: z.object({ id: z.string().uuid(), text: z.string(), status: z.enum(['review','changes','approved']), revision: z.number().optional(), artifactHash: z.string().optional(), instructionSnapshotId: z.string().optional(), directory: z.string().optional() }).optional(),
  pendingMessages: z.array(z.object({
    id: z.string().uuid(), text: z.string(),
    attachments: z.array(z.object({ id: z.string().uuid().optional(), path: z.string(), fileName: z.string(), kind: z.enum(['image', 'pdf', 'audio', 'file']), mime: z.string().optional() }).passthrough()).optional()
  })).max(100).optional(),
  projectId: z.string().uuid().optional(),
  id: z.string().min(1),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  harness: z.enum(['valley', 'deepseek', 'openai-modified']).optional(),
  model: modelRef.nullable().optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  profileId: z.string().optional(),
  pinned: z.boolean().optional(),
  attachmentParser: z.string().optional(),
  messages: z.array(aiMessage),
  source: z.enum(['telegram', 'whatsapp']).optional(),
  channelId: z.string().optional(),
  chatRef: z.string().optional(),
  channelName: z.string().optional(),
  channelIdentity: z.string().optional(),
  commands: z.array(customCommand).optional(),
  quiz: quizPrompt.nullable().optional()
})

const personality = z.object({
  id: z.string().min(1),
  name: z.string(),
  isDefault: z.boolean(),
  instructions: z.string(),
  routing: routingConfig
})

const memoryEntry = z.object({
  id: z.string().min(1),
  summary: z.string(),
  confidence: z.number().optional(),
  sourceChatId: z.string().optional(),
  createdAt: z.number()
})

export const aiDriver = defineDriver({
  listHarnesses: defineDriverMethod(z.object({}).optional(), async (root) => {
    await ensureHarnessPackages(root)
    return { harnesses: listHarnessPackageStatuses() }
  }),
  readHarnessPackage: defineDriverMethod(z.object({ id: harnessId }), async (root, payload) => ({
    package: await readHarnessPackage(root, payload.id)
  })),
  createHarness: defineDriverMethod(z.object({ package: z.record(z.unknown()) }), async (root, payload) => {
    await createHarnessPackage(root, payload.package as unknown as HarnessCreatePackage)
    return { harnesses: await reloadHarnessPackages(root) }
  }),
  writeHarnessFile: defineDriverMethod(z.object({
    id: harnessId,
    path: z.string().min(1),
    content: z.string(),
    baseline: harnessBaseline
  }), (root, payload) => writeHarnessFile(root, payload.id, payload.path, payload.content, payload.baseline)),
  updateHarnessManifest: defineDriverMethod(z.object({
    id: harnessId,
    manifest: z.record(z.unknown()),
    baseline: harnessBaseline
  }), (root, payload) => {
    const manifest = payload.manifest as unknown as HarnessManifest
    if (manifest.id !== payload.id) throw new Error(t('assistant.backend.packageIdMismatch'))
    return writeHarnessFile(root, payload.id, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`, payload.baseline)
  }),
  updateHarnessConfig: defineDriverMethod(z.object({
    id: harnessId,
    config: z.record(z.unknown()),
    baseline: harnessBaseline
  }), (root, payload) => writeHarnessFile(
    root,
    payload.id,
    'config.json',
    `${JSON.stringify(payload.config as unknown as HarnessConfig, null, 2)}\n`,
    payload.baseline
  )),
  saveHarnessSettings: defineDriverMethod(z.object({
    id: harnessId,
    values: z.record(z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string())]))
  }), async (root, payload) => {
    await saveHarnessSettings(root, payload.id, payload.values as Record<string, HarnessSettingValue>)
    return { harnesses: await reloadHarnessPackages(root) }
  }),
  reloadHarnesses: defineDriverMethod(z.object({}).optional(), async (root) => ({
    harnesses: await reloadHarnessPackages(root)
  })),
  runHarness: defineDriverMethod(z.object({
    id: harnessId,
    targets: z.array(harnessTarget).min(1).max(32),
    options: z.object({ useCache: z.boolean().optional(), concurrency: z.number().int().positive().max(8).optional() }).optional()
  }), async (root, payload) => ({ run: await startHarnessRun(root, payload.id, payload.targets, payload.options) })),
  cancelHarnessRun: defineDriverMethod(z.object({ runId: z.string().min(1) }), (_root, payload) => ({ cancelled: cancelHarnessRun(payload.runId) })),
  listHarnessRuns: defineDriverMethod(z.object({ id: harnessId, limit: z.number().int().positive().max(50).optional() }), async (root, payload) => ({
    runs: await listHarnessRuns(root, payload.id, payload.limit)
  })),
  readHarnessRun: defineDriverMethod(z.object({ runId: z.string().min(1) }), async (root, payload) => ({
    run: await readHarnessRun(root, payload.runId)
  })),
  clearHarnessCache: defineDriverMethod(z.object({ id: harnessId }), async (root, payload) => {
    await clearHarnessCache(root, payload.id)
    return { ok: true }
  }),
  chat: defineDriverMethod(chatRequest, (root, payload) => {
      const req = payload
      void startRun(root, req)
      return { requestId: req.requestId }
    }),
  cancel: defineDriverMethod(z.object({ requestId: z.string() }), (_root, payload) => cancelRun(payload.requestId)),
  ingestAttachment: defineDriverMethod(z.object({
      path: z.string().min(1),
      kind: z.enum(['image', 'pdf', 'audio', 'file']),
      parser: z.string().optional()
    }), async (root, payload) => {
      const p = payload
      return ingestAttachment(root, p)
    }),
  // `baseUrl` overrides the saved value so the settings "Test connection" button can
  // probe exactly what's in the input box (live, before Save). `noCache`/`strict` make
  // Test meaningful: both bypass the cache (a cached OK must not mask a now-broken
  // endpoint), and `strict` makes discovery throw on a failed/unauthorized request
  // instead of silently falling back to the provider's static default list.
  listModels: defineDriverMethod(z.object({ provider, connectionId: connectionId.optional() }), async (_root, input) => ({ models: await backendApi().ai.models(input) })),
  providerStatus: defineDriverMethod(z.object({}).optional(), async (root) => ({ providers: (await readConfig(root)).providers })),
  // ── Connections ────────────────────────────────────────────────────────────
  // A provider may hold any number of credentials; the connection, not the
  // provider, is what Settings lists and what usage is billed against. The
  // provider-grained `setKey`/`setBaseUrl` below stay as the default connection's
  // shorthand so every existing plugin/SDK caller keeps working.
  listConnections: defineDriverMethod(z.object({}).optional(), async (root) => ({ connections: await listConnections(root) })),
  getConfig: defineDriverMethod(z.object({}).optional(), (root) => readConfig(root)),
  writeRule: defineDriverMethod(z.object({ name: z.string(), content: z.string() }), (root, payload) => {
      const { name, content } = payload
      return writeRule(root, name, content)
    }),
  // Guard policy (`guards.json`) — the single permission rule set. The payload is
  // validated loosely and normalized in main (tolerant: a partial object merges
  // onto defaults, hard-blocks are always re-seeded), so the renderer can never
  // persist a malformed or weakened policy.
  getGuard: defineDriverMethod(z.object({}).optional(), async (root) => ({ guard: await readGuardPolicy(root) })),
  appendGuardAudit: defineDriverMethod(z.object({ entry: guardAuditEntry }), async (root, payload) => {
      await appendGuardAudit(root, payload.entry)
      return { ok: true }
    }),
  // Pending channel approvals (C8) — persisted to `.valley/assistant/runtime/` so a
  // Telegram button tapped after a restart is recognized (and the runtime trail is
  // legible). The live promise/resolver stays renderer-side; only this record is on disk.
  addPending: defineDriverMethod(z.object({
      record: z.object({
        requestId: z.string().min(1),
        channelId: z.string().optional(),
        chatRef: z.string().optional(),
        chatId: z.string(),
        actionLabel: z.string(),
        createdAt: z.number(),
        expiresAt: z.number()
      })
    }), async (root, payload) => {
      await addPending(root, payload.record)
      return { ok: true }
    }),
  removePending: defineDriverMethod(z.object({ requestId: z.string().min(1) }), async (root, payload) => {
      await removePending(root, payload.requestId)
      return { ok: true }
    }),
  listPending: defineDriverMethod(z.object({}).optional(), async (root) => ({ pending: await listPending(root) })),
  // Plugin guard presets (C15): the snapshot the Guards "Plugin presets" panel
  // renders — which plugins ship presets, their applied/skipped state, and whether
  // a newer version needs review. The command/tool catalog itself is built
  // renderer-side (from getAllCommands + the assistant tool catalog).
  listChats: defineDriverMethod(z.object({}).optional(), async (root) => ({ chats: await listChats(root) })),
  readChat: defineDriverMethod(z.object({ id: z.string() }), async (root, payload) => ({ thread: await readChat(root, payload.id) })),
  saveChat: defineDriverMethod(z.object({ thread: chatThread }), (root, payload) => saveChat(root, payload.thread)),
  renameChat: defineDriverMethod(z.object({ id: z.string(), title: z.string() }), (root, payload) => renameChat(root, payload.id, payload.title)),
  deleteChat: defineDriverMethod(z.object({ id: z.string() }), (root, payload) => deleteChat(root, payload.id)),
  // `/clear`: wipe a chat's active context but keep its long-term memory.jsonl.
  clearChat: defineDriverMethod(z.object({ id: z.string() }), (root, payload) => clearChat(root, payload.id)),
  setChatPinned: defineDriverMethod(z.object({ id: z.string(), pinned: z.boolean() }), (root, payload) => setChatPinned(root, payload.id, payload.pinned)),
  // Per-chat guard overrides (`guard-overrides.json`) — remembered approval choices
  // (narrow-only; the resolver clamps them and main re-enforces the global ceiling).
  readGuardOverrides: defineDriverMethod(z.object({ chatId: z.string() }), async (root, payload) => ({ overrides: await readGuardOverrides(root, payload.chatId) })),
  saveGuardOverrides: defineDriverMethod(z.object({ chatId: z.string(), overrides: guardOverrides }), async (root, payload) => {
      const { chatId, overrides } = payload
      await saveGuardOverrides(root, { id: chatId }, overrides)
      return { ok: true }
    }),
  // ── Personalities (Meadow/Chorus/Personalities/<id>/) ────────────────────────
  listPersonalities: defineDriverMethod(z.object({}).optional(), async (root) => ({ personalities: await listPersonalities(root) })),
  readPersonality: defineDriverMethod(z.object({ id: z.string() }), async (root, payload) => ({ personality: await readPersonality(root, payload.id) })),
  savePersonality: defineDriverMethod(z.object({ personality }), (root, payload) => savePersonality(root, payload.personality)),
  deletePersonality: defineDriverMethod(z.object({ id: z.string() }), (root, payload) => deletePersonality(root, payload.id)),
  // ── Overall custom commands (Meadow/Chorus/commands.json) ────────────────────
  listCommands: defineDriverMethod(z.object({}).optional(), async (root) => ({ commands: await readCommands(root) })),
  saveCommands: defineDriverMethod(z.object({ commands: z.array(customCommand) }), async (root, payload) => {
      await saveCommands(root, payload.commands)
      return { ok: true }
    }),
  // ── Memory (per-chat memory.jsonl; explicit summarize flow) ──────────────────
  // Writes are re-checked against the file guard in main (memory lives under
  // Meadow/Chorus), so a `deny`/hard-block is honored regardless of the renderer.
  appendMemory: defineDriverMethod(z.object({ chatId: z.string(), entry: memoryEntry }), async (root, payload) => {
      const { chatId, entry } = payload
      await appendMemory(root, { id: chatId }, entry)
      return { ok: true }
    }),
  readMemory: defineDriverMethod(z.object({ chatId: z.string() }), async (root, payload) => ({ memory: await readMemory(root, payload.chatId) })),
  // Usage/cost is metered in the engine and stored encrypted in userData (not
  // the vault). The renderer can only read aggregates and set the budget —
  // there is intentionally no `recordUsage` channel, so spend can't be forged.

})
