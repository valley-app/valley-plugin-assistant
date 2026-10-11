import type { DatasetRecord, PluginBackendOperationContext } from '@valley/plugin-sdk'
type OwnerApi = PluginBackendOperationContext['api']
type DatasetRow = DatasetRecord & { state?: string }
import { stopChatProcesses } from './processScopes'
import { assertChatWritable, referenceAttachments, deleteChatData, markChatDeleting, datasetRows } from './attachments'
import { cancelChatRuns } from './engine'
import { t, backendApi } from './runtime'
import * as fs from './filesystem'
import path from 'path-browserify'
import type { AiChatSummary, AiChatSource, AiChatThread, AiMessage, AiProviderId, CustomCommand } from '../types'
import type { GuardOverrides } from '@valley/plugin-sdk/guard/types'
import { atomicWriteFile } from './filesystem'
import { chatDir, chorusChannelsDir, chorusChatsDir, isSafeName, safeSegment } from './paths'
import { queuedWriteJson, runExclusive } from './fileQueue'
import { readJson, readText } from './repositoryFiles'
import { normalizeCommands } from './commandConfig'
import { conversationConfiguration } from './configuration/conversations'
import { transportValue } from './transport'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { z } from 'zod'

// ── Chats (Meadow/Chorus folders) ────────────────────────────────────────────
// Each chat is a folder: `settings.json` (meta), an append-only `thread.jsonl`
// (messages, C12), and an optional `memory.jsonl`. App chats live under
// `Chats/<id>/`; remote-channel chats split under `Channels/<channelId>/<chatRef>/`.

/** The standalone settings.json shape (the meta, minus the messages). */
interface ChatMeta {
  titleOrigin?: 'manual' | 'generated' | 'fallback'
  titleRevision?: number
  configurationHash?: string
  configurationRevision?: number
  instructionsPath?: string
  mode?: AiChatThread['mode']
  plan?: AiChatThread['plan']
  preview?: string
  messageCount?: number
  pendingMessages?: import('../types').PendingMessage[]
  harness?: import('../types').HarnessId
  projectId?: string
  id: string
  title: string
  createdAt: number
  updatedAt: number
  model?: { provider: AiProviderId; model: string; connectionId?: string } | null
  reasoningEffort?: import('../types').ReasoningEffort
  attachmentParser?: string
  profileId?: string
  source?: AiChatSource
  channelId?: string
  channelSenderId?: string
  channelTopicId?: string
  chatRef?: string
  channelName?: string
  channelIdentity?: string
  commands?: CustomCommand[]
  pinned?: boolean
}

const SETTINGS_FILE = 'settings.json'
const THREAD_FILE = 'thread.jsonl'
const GUARD_OVERRIDES_FILE = 'guard-overrides.json'

const settingsFile = (dir: string): string => path.join(dir, SETTINGS_FILE)
const threadFile = (dir: string): string => path.join(dir, THREAD_FILE)
const guardOverridesFile = (dir: string): string => path.join(dir, GUARD_OVERRIDES_FILE)

async function pathExists(file: string, api: OwnerApi = backendApi()): Promise<boolean> {
  try {
    await fs.access(file, api)
    return true
  } catch {
    return false
  }
}

function messagePreview(messages: AiMessage[]): string {
  const message = [...messages].reverse().find(message => (message.role === 'assistant' || message.role === 'user') && message.content.trim())
  return message?.content.replace(/\s+/g, ' ').trim().slice(0, 240) ?? ''
}

function metaOf(thread: AiChatThread): ChatMeta {
  return {
    mode: thread.mode,
    plan: thread.plan,
    preview: messagePreview(thread.messages),
    messageCount: thread.messages.length,
    pendingMessages: thread.pendingMessages,
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    titleOrigin: thread.titleOrigin,
    titleRevision: thread.titleRevision,
    configurationHash: thread.configurationHash,
    configurationRevision: thread.configurationRevision,
    instructionsPath: thread.instructionsPath,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    model: thread.model ?? null,
    reasoningEffort: thread.reasoningEffort,
    harness: thread.harness,
    attachmentParser: thread.attachmentParser,
    profileId: thread.profileId,
    source: thread.source,
    channelId: thread.channelId,
    channelSenderId: thread.channelSenderId,
    channelTopicId: thread.channelTopicId,
    chatRef: thread.chatRef,
    channelName: thread.channelName,
    channelIdentity: thread.channelIdentity,
    commands: thread.commands?.length ? normalizeCommands(thread.commands) : undefined,
    pinned: thread.pinned
  }
}

function threadFromMeta(meta: ChatMeta, messages: AiMessage[]): AiChatThread {
  return transportValue({
    mode: meta.mode,
    plan: meta.plan,
    pendingMessages: meta.pendingMessages,
    id: meta.id,
    projectId: meta.projectId,
    title: meta.title,
    titleOrigin: meta.titleOrigin,
    titleRevision: meta.titleRevision,
    configurationHash: meta.configurationHash,
    configurationRevision: meta.configurationRevision,
    instructionsPath: meta.instructionsPath,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    model: meta.model,
    reasoningEffort: meta.reasoningEffort,
    harness: meta.harness,
    attachmentParser: meta.attachmentParser,
    profileId: meta.profileId,
    messages,
    source: meta.source,
    channelId: meta.channelId,
    channelSenderId: meta.channelSenderId,
    channelTopicId: meta.channelTopicId,
    chatRef: meta.chatRef,
    channelName: meta.channelName,
    channelIdentity: meta.channelIdentity,
    commands: meta.commands?.length ? meta.commands : undefined,
    pinned: meta.pinned
  })
}

/** Tolerant parse of one folder's `settings.json` → meta (null if absent/invalid). */
async function readMeta(dir: string, api: OwnerApi = backendApi()): Promise<ChatMeta | null> {
  const meta = await readJson<ChatMeta | null>(settingsFile(dir), null, api)
  return meta && typeof meta.id === 'string' ? meta : null
}

/** Tolerant parse of `thread.jsonl` → messages (skips malformed lines). */
async function readThreadMessages(dir: string, api: OwnerApi = backendApi()): Promise<AiMessage[]> {
  const text = await readText(threadFile(dir), api)
  if (!text) return []
  const messages: AiMessage[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      messages.push(JSON.parse(line) as AiMessage)
    } catch {
      // skip a malformed message line
    }
  }
  return messages
}

/**
 * Resolve a chat id to its on-disk folder. App chats are addressed directly
 * (`Chats/<id>/`); a remote-channel id (`tg-…` / `wa-…`) is not reliably
 * parseable, so we scan `Channels/<*>/<*>/` for a matching `settings.json`.
 * Returns null when the chat does not exist.
 */
export async function resolveChatDir(vaultRoot: string, id: string, api: OwnerApi = backendApi()): Promise<string | null> {
  if (!isSafeName(id)) return null
  const appDir = path.join(chorusChatsDir(vaultRoot), safeSegment(id))
  if (await pathExists(settingsFile(appDir), api)) return appDir
  let channels: import('./filesystem').DirectoryEntry[]
  try {
    channels = await fs.readdir(chorusChannelsDir(vaultRoot), { withFileTypes: true }, api)
  } catch {
    return null
  }
  for (const ch of channels) {
    if (!ch.isDirectory()) continue
    let refs: import('./filesystem').DirectoryEntry[]
    try {
      refs = await fs.readdir(path.join(chorusChannelsDir(vaultRoot), ch.name), { withFileTypes: true }, api)
    } catch {
      continue
    }
    for (const ref of refs) {
      if (!ref.isDirectory()) continue
      const dir = path.join(chorusChannelsDir(vaultRoot), ch.name, ref.name)
      if ((await readMeta(dir, api))?.id === id) return dir
    }
  }
  return null
}

export async function listChats(vaultRoot: string, includeEmpty = false, api: OwnerApi = backendApi()): Promise<AiChatSummary[]> {
  const byId = new Map<string, AiChatSummary>()
  const add = async (meta: ChatMeta, dir: string): Promise<void> => {
    if (!includeEmpty && !(meta.messageCount ?? (await readThreadMessages(dir, api)).length) && !meta.pendingMessages?.length) return
    // Emit `model`/`profileId` only when set — an explicit `null`/`undefined`
    // would change object identity for equality-based consumers.
    const summary: AiChatSummary = { id: meta.id, title: meta.title, updatedAt: meta.updatedAt }
    const preview = meta.preview ?? messagePreview(await readThreadMessages(dir, api))
    if (preview) summary.preview = preview
    if (meta.projectId) summary.projectId = meta.projectId
    if (meta.harness) summary.harness = meta.harness
    if (meta.model) summary.model = meta.model
    if (meta.profileId) summary.profileId = meta.profileId
    if (meta.source) summary.source = meta.source
    if (meta.channelId) summary.channelId = meta.channelId
    if (meta.channelName) summary.channelName = meta.channelName
    if (meta.channelIdentity) summary.channelIdentity = meta.channelIdentity
    if (meta.commands?.length) summary.commands = meta.commands
    if (meta.pinned) summary.pinned = true
    byId.set(meta.id, summary)
  }
  // App chats: one folder each under Chats/.
  try {
    for (const d of await fs.readdir(chorusChatsDir(vaultRoot), { withFileTypes: true }, api)) {
      if (!d.isDirectory()) continue
      const meta = await readMeta(path.join(chorusChatsDir(vaultRoot), d.name), api)
      if (meta) await add(meta, path.join(chorusChatsDir(vaultRoot), d.name))
    }
  } catch {
    /* no app chats yet */
  }
  // Remote-channel chats: Channels/<channelId>/<chatRef>/.
  try {
    for (const ch of await fs.readdir(chorusChannelsDir(vaultRoot), { withFileTypes: true }, api)) {
      if (!ch.isDirectory()) continue
      const channelDir = path.join(chorusChannelsDir(vaultRoot), ch.name)
      for (const ref of await fs.readdir(channelDir, { withFileTypes: true }, api)) {
        if (!ref.isDirectory()) continue
        const meta = await readMeta(path.join(channelDir, ref.name), api)
        if (meta) await add(meta, path.join(channelDir, ref.name))
      }
    }
  } catch {
    /* no remote-channel chats yet */
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function readChat(vaultRoot: string, id: string, api: OwnerApi = backendApi()): Promise<AiChatThread | null> {
  if (!isSafeName(id)) return null
  const dir = await resolveChatDir(vaultRoot, id, api)
  if (dir) {
    const meta = await readMeta(dir, api)
    if (meta) {
      const configuration = await conversationConfiguration(vaultRoot, dir, meta, undefined, undefined, api)
      return threadFromMeta({ ...meta, ...configuration.settings, configurationHash: configuration.hash, configurationRevision: configuration.revision, instructionsPath: configuration.instructionsPath }, await readThreadMessages(dir, api))
    }
  }
  return null
}

async function indexChat(thread: AiChatThread, api: OwnerApi = backendApi()): Promise<void> {
  if (!thread.messages.length && !thread.pendingMessages?.length) { await api.data.dataset('chat_search').delete({ id: thread.id }); return }
  const messages = thread.messages.filter(message => (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
  await api.data.dataset('chat_search').upsert({ id: thread.id, title: thread.title, content: messages.map(message => message.content).join('\n'), preview: messagePreview(messages), updatedAt: thread.updatedAt })
}

async function updateChatSearch(operation: () => Promise<void>, api: OwnerApi = backendApi()): Promise<void> {
  try { await operation() } catch (error) { api.rpc.emit('backendError', String(error)) }
}

export async function rebuildChatSearch(vaultRoot: string, api: OwnerApi = backendApi()): Promise<void> {
  const dataset = api.data.dataset('chat_search')
  const existing = new Map((await datasetRows(dataset)).map(row => [row.id, row]))
  for (const summary of await listChats(vaultRoot, false, api)) {
    const cached = existing.get(summary.id)
    if (!cached || cached.updatedAt !== summary.updatedAt || cached.title !== summary.title) {
      const thread = await readChat(vaultRoot, summary.id, api)
      if (thread) await indexChat(thread, api)
    }
    existing.delete(summary.id)
  }
  for (const id of existing.keys()) if (typeof id === 'string') await dataset.delete({ id })
}

export async function saveChat(vaultRoot: string, thread: AiChatThread, api: OwnerApi = backendApi()): Promise<void> {
  if (!isSafeName(thread.id)) throw new Error(t('assistant.backend.invalidChat', { value: thread.id }))
  return runExclusive(`chat:${thread.id}`, async () => {
  await assertChatWritable(thread.id, api)
  if (thread.projectId) {
    const project = await api.data.dataset('projects').get({ id: thread.projectId })
    if (!project || project.deleting) delete thread.projectId
  }
  await referenceAttachments(thread.id, [...thread.messages, ...(thread.pendingMessages ?? []).map(item => ({ role: 'user' as const, content: item.text, attachmentIds: item.attachments?.flatMap(attachment => attachment.id ? [attachment.id] : []) }))], api)
  const dir = chatDir(vaultRoot, thread)
  await fs.mkdir(dir, { recursive: true }, api)
  const prior = await readMeta(dir, api)
  const configuration = await conversationConfiguration(vaultRoot, dir, prior ?? thread, thread, thread.configurationRevision, api)
  Object.assign(thread, configuration.settings, { configurationHash: configuration.hash, configurationRevision: configuration.revision, instructionsPath: configuration.instructionsPath })
  if (prior && (prior.titleOrigin === 'manual' || prior.titleOrigin === 'generated' && (thread.titleRevision ?? 0) <= (prior.titleRevision ?? 0))) { thread.title = prior.title; thread.titleOrigin = prior.titleOrigin; thread.titleRevision = prior.titleRevision; thread.channelIdentity = prior.channelIdentity ?? thread.channelIdentity }
  else if (prior && thread.title !== prior.title && thread.titleOrigin !== 'generated' && thread.titleOrigin !== 'fallback') { thread.titleOrigin = 'manual'; thread.titleRevision = (prior.titleRevision ?? 0) + 1 }
  await queuedWriteJson(settingsFile(dir), metaOf(thread), api)
  const file = threadFile(dir)
  await runExclusive(file, async () => {
    const existing = await readThreadMessages(dir, api)
    const unchangedPrefix = thread.messages.length >= existing.length
      && existing.every((message, index) => JSON.stringify(message) === JSON.stringify(thread.messages[index]))
    if (unchangedPrefix) {
      const delta = thread.messages.slice(existing.length)
      if (delta.length) await fs.appendFile(file, delta.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8', api)
    } else {
      await atomicWriteFile(file, thread.messages.map((m) => JSON.stringify(m)).join('\n') + (thread.messages.length ? '\n' : ''), api)
    }
  }, api)
  await updateChatSearch(() => indexChat(thread, api), api)
  }, api)
}

async function existingChat(vaultRoot: string, id: string, api: OwnerApi): Promise<{ dir: string; meta: ChatMeta }> {
  try {
    if (isSafeName(id)) {
      await assertChatWritable(id, api)
      const dir = await resolveChatDir(vaultRoot, id, api)
      const meta = dir ? await readMeta(dir, api) : null
      if (dir && meta) return { dir, meta }
    }
  } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { outcome: 'not-applied', retryable: false }) }
  throw Object.assign(new Error(t('assistant.surface.missing')), { code: 'CONVERSATION_NOT_FOUND', outcome: 'not-applied', retryable: false })
}

export async function renameChat(vaultRoot: string, id: string, title: string, api: OwnerApi = backendApi()): Promise<void> {
  return runExclusive(`chat:${id}`, async () => {
  const { dir, meta } = await existingChat(vaultRoot, id, api)
  await queuedWriteJson(settingsFile(dir), { ...meta, ...(meta.source ? { channelIdentity: meta.channelIdentity || meta.title } : {}), title, titleOrigin: 'manual', titleRevision: (meta.titleRevision ?? 0) + 1 }, api)
  await updateChatSearch(async () => { const thread = await readChat(vaultRoot, id, api); if (thread) await indexChat(thread, api) }, api)
  }, api)
}

export async function applyGeneratedTitle(vaultRoot: string, id: string, title: string, expected: { title: string; revision: number }, api: OwnerApi = backendApi()): Promise<boolean> {
  if (!isSafeName(id) || !title.trim()) return false
  return runExclusive(`chat:${id}`, async () => {
    await assertChatWritable(id, api)
    const dir = await resolveChatDir(vaultRoot, id, api)
    if (!dir) return false
    const meta = await readMeta(dir, api)
    if (!meta || meta.titleOrigin !== 'fallback' || meta.title !== expected.title || (meta.titleRevision ?? 0) !== expected.revision) return false
    await queuedWriteJson(settingsFile(dir), { ...meta, title, titleOrigin: 'generated', titleRevision: expected.revision + 1, ...(meta.source ? { channelIdentity: meta.channelIdentity || meta.title } : {}) }, api)
    await updateChatSearch(async () => { const thread = await readChat(vaultRoot, id, api); if (thread) await indexChat(thread, api) }, api)
    api.rpc.emit('conversations.changed', { id })
    return true
  }, api)
}

export async function setChatPinned(vaultRoot: string, id: string, pinned: boolean, api: OwnerApi = backendApi()): Promise<void> {
  return runExclusive(`chat:${id}`, async () => {
  const { dir, meta } = await existingChat(vaultRoot, id, api)
  await queuedWriteJson(settingsFile(dir), { ...meta, pinned: pinned || undefined }, api)
  }, api)
}

export async function deleteChat(vaultRoot: string, id: string, api: OwnerApi = backendApi()): Promise<void> {
  if (!isSafeName(id)) return
  await runExclusive(`chat:${id}`, async () => { await markChatDeleting(id, await resolveChatDir(vaultRoot, id, api) ?? '', api) }, api)
  await cancelChatRuns(id, api)
  await stopChatProcesses(id, true, api)
  await runExclusive(`chat:${id}`, async () => {
    const dir = await resolveChatDir(vaultRoot, id, api)
    await deleteChatData(id, dir ?? '', api)
    await updateChatSearch(async () => { await api.data.dataset('chat_search').delete({ id }) }, api)
  }, api)
}

/**
 * Wipe a chat's active context (the `/clear` command) WITHOUT deleting its
 * long-term `memory.jsonl` — the thread is reset but extracted facts persist.
 */
export async function clearChat(vaultRoot: string, id: string, api: OwnerApi = backendApi()): Promise<void> {
  if (!isSafeName(id)) return
  return runExclusive(`chat:${id}`, async () => {
  await assertChatWritable(id, api)
  const dir = await resolveChatDir(vaultRoot, id, api)
  if (dir) {
    await fs.rm(threadFile(dir), { force: true }, api)
    const meta = await readMeta(dir, api)
    if (meta) {
      const cleared = { ...meta, preview: '', messageCount: 0, updatedAt: Date.now() }
      await queuedWriteJson(settingsFile(dir), cleared, api)
      await updateChatSearch(() => indexChat(threadFromMeta(cleared, []), api), api)
    }
  }
  }, api)
}

// ── Chat restore (command receipts and renderer reverts for delete/clear) ────
// Only an app chat with no attachments, coordinator session, deletion or cleanup record and a bounded folder can be captured; its
// exact bytes are rewritten only while the chat still has the revision observed right after the original operation.
const CHAT_SNAPSHOT_BYTES = 512 * 1024
const chatEntrySchema = z.object({ path: z.string().min(1).max(512).refine(value => value.split('/').every(part => part && part !== '.' && part !== '..')), kind: z.enum(['folder', 'file']), base64: z.string().max(CHAT_SNAPSHOT_BYTES * 2).optional() }).strict()
export const chatSnapshotSchema = z.object({ id: z.string().min(1).max(256).refine(isSafeName), entries: z.array(chatEntrySchema).min(1).max(64) }).strict()
export type ChatSnapshot = z.infer<typeof chatSnapshotSchema>
async function chatEntries(dir: string, api: OwnerApi): Promise<ChatSnapshot['entries'] | null> {
  const entries: ChatSnapshot['entries'] = [], pending = ['']
  let bytes = 0
  while (pending.length) {
    const rel = pending.shift()!
    const children = (await fs.readdir(rel ? path.join(dir, rel) : dir, { withFileTypes: true }, api)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of children) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entries.length >= 64 || entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) return null
      if (entry.isDirectory()) { entries.push({ path: child, kind: 'folder' }); pending.push(child); continue }
      const read = await fs.readBoundedBase64(path.join(dir, child), CHAT_SNAPSHOT_BYTES - bytes, api)
      if (!read) return null
      bytes += read.bytes
      entries.push({ path: child, kind: 'file', base64: read.base64 })
    }
  }
  return entries
}
const stale = () => Object.assign(new Error('The conversation changed after this operation; restoring it would overwrite newer changes'), { code: 'UNDO_CONFLICT_STALE_TARGET', outcome: 'not-applied' })
export async function chatRevision(vaultRoot: string, id: string, api: OwnerApi = backendApi()): Promise<string> {
  const dir = isSafeName(id) ? await resolveChatDir(vaultRoot, id, api) : null, cleanup = isSafeName(id) ? await api.data.dataset<DatasetRow>('chat_cleanup').get({ id }) : null
  const entries = dir ? await chatEntries(dir, api) : []
  const meta = dir && !entries ? await readMeta(dir, api) : null
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify({ dir: dir && path.relative(vaultRoot, dir), entries: entries?.map(entry => [entry.path, entry.kind, entry.base64 === undefined ? null : bytesToHex(sha256(new TextEncoder().encode(entry.base64)))]) ?? { unbounded: meta?.updatedAt ?? null }, cleanup: cleanup?.state ?? null }))))
}
export async function captureChat(vaultRoot: string, id: string, api: OwnerApi = backendApi()): Promise<ChatSnapshot | null> {
  if (!isSafeName(id)) return null
  const dir = await resolveChatDir(vaultRoot, id, api)
  if (dir !== path.join(chorusChatsDir(vaultRoot), safeSegment(id))) return null
  for (const dataset of ['chat_cleanup', 'conversation_deletions', 'sessions']) if (await api.data.dataset<DatasetRow>(dataset).get({ id })) return null
  if (await api.data.dataset<DatasetRow>('attachment_refs').count({ chatId: id })) return null
  const entries = await chatEntries(dir, api)
  return entries?.length ? { id, entries } : null
}
export async function restoreChat(vaultRoot: string, raw: unknown, expectedRevision: unknown, api: OwnerApi = backendApi()): Promise<void> {
  const snapshot = chatSnapshotSchema.parse(raw), dir = path.join(chorusChatsDir(vaultRoot), safeSegment(snapshot.id))
  await runExclusive(`chat:${snapshot.id}`, async () => {
    if (typeof expectedRevision !== 'string' || await chatRevision(vaultRoot, snapshot.id, api) !== expectedRevision) throw stale()
    const current = await resolveChatDir(vaultRoot, snapshot.id, api)
    if (current && current !== dir) throw stale()
    await fs.mkdir(dir, { recursive: true }, api)
    for (const entry of snapshot.entries) {
      const file = path.join(dir, entry.path)
      if (entry.kind === 'folder') await fs.mkdir(file, { recursive: true }, api)
      else await runExclusive(file, () => atomicWriteFile(file, fs.base64Bytes(entry.base64 ?? ''), api), api)
    }
    await api.data.transaction([{ dataset: 'chat_cleanup', operation: 'delete', key: { id: snapshot.id } }, { dataset: 'conversation_deletions', operation: 'delete', key: { id: snapshot.id } }])
    await updateChatSearch(async () => { const thread = await readChat(vaultRoot, snapshot.id, api); if (thread) await indexChat(thread, api) }, api)
  }, api)
}
// Sealed test fixtures only (sealedTest.ts): the bounded entries of one app chat folder, [] when absent, null when unbounded or elsewhere.
export async function chatEntriesOf(vaultRoot: string, id: string, api: OwnerApi = backendApi()): Promise<ChatSnapshot['entries'] | null> {
  const dir = path.join(chorusChatsDir(vaultRoot), safeSegment(id)), current = isSafeName(id) ? await resolveChatDir(vaultRoot, id, api) : null
  return current === null ? [] : current === dir ? chatEntries(dir, api) : null
}
// The chat folder becomes exactly the captured entries again: extra files and folders are removed, captured bytes rewritten.
export async function rewriteChat(vaultRoot: string, raw: unknown, api: OwnerApi = backendApi()): Promise<void> {
  const snapshot = chatSnapshotSchema.parse(raw), dir = path.join(chorusChatsDir(vaultRoot), safeSegment(snapshot.id))
  await runExclusive(`chat:${snapshot.id}`, async () => {
    const present = await chatEntriesOf(vaultRoot, snapshot.id, api)
    if (!present) throw stale()
    const kept = new Map(snapshot.entries.map(entry => [entry.path, entry.kind]))
    for (const entry of [...present].reverse()) if (kept.get(entry.path) !== entry.kind) await fs.rm(path.join(dir, entry.path), { recursive: true, force: true }, api)
    await fs.mkdir(dir, { recursive: true }, api)
    for (const entry of snapshot.entries) {
      const file = path.join(dir, entry.path)
      if (entry.kind === 'folder') await fs.mkdir(file, { recursive: true }, api)
      else await runExclusive(file, () => atomicWriteFile(file, fs.base64Bytes(entry.base64 ?? ''), api), api)
    }
    await updateChatSearch(async () => { const thread = await readChat(vaultRoot, snapshot.id, api); if (thread) await indexChat(thread, api); else await api.data.dataset('chat_search').delete({ id: snapshot.id }) }, api)
  }, api)
}

// ── Per-chat guard overrides (guard-overrides.json, narrow-only) ──────────────
// Remembered approval choices ("Always allow/ask/block here", in-app or remote channel)
// persist beside the chat as a `GuardOverrides` (spec §4.4). They can only narrow
// the global policy or pre-approve a globally pre-approvable `confirm`; the shared
// resolver enforces that, and main re-enforces the global ceiling — so persisting
// the raw choice is safe.

/** Read a chat's persisted guard overrides (null when absent). */
export async function readGuardOverrides(vaultRoot: string, id: string, api: OwnerApi = backendApi()): Promise<GuardOverrides | null> {
  if (!isSafeName(id)) return null
  const dir = await resolveChatDir(vaultRoot, id, api)
  if (!dir) return null
  return readJson<GuardOverrides | null>(guardOverridesFile(dir), null, api)
}

/**
 * Persist a chat's guard overrides (atomic, queued, C16). The chat folder is taken
 * from `thread` when given (so a brand-new remote-channel chat resolves), else by id.
 */
export async function saveGuardOverrides(vaultRoot: string, ref: { id: string } | AiChatThread, overrides: GuardOverrides, api: OwnerApi = backendApi()): Promise<void> {
  if (!isSafeName(ref.id)) throw new Error(t('assistant.backend.invalidChat', { value: ref.id }))
  return runExclusive(`chat:${ref.id}`, async () => {
  await assertChatWritable(ref.id, api)
  const dir =
    'messages' in ref ? chatDir(vaultRoot, ref) : (await resolveChatDir(vaultRoot, ref.id, api)) ?? path.join(chorusChatsDir(vaultRoot), safeSegment(ref.id))
  await fs.mkdir(dir, { recursive: true }, api)
  await queuedWriteJson(guardOverridesFile(dir), overrides, api)
  }, api)
}
