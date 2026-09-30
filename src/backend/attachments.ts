import { z } from 'zod'
import path from 'path-browserify'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { DatasetRecord, PluginDatasetApi } from '@valley/plugin-sdk'
import type { AiMessage, InboundAttachment } from '../types'
import { backendApi, VAULT_ROOT } from './runtime'
import * as fs from './filesystem'
import { stopChatProcesses } from './processScopes'
import { runExclusive } from './fileQueue'
import { detectType } from './attachments/detectType'
import { effectiveSettings } from './configuration/settings'

type Attachment = DatasetRecord & { id: string; path: string; fileName: string; mime: string; kind: InboundAttachment['kind']; owned: boolean; sha256: string; state: string; createdAt: number }
type Reference = DatasetRecord & { attachmentId: string; chatId: string }
type Cleanup = DatasetRecord & { id: string; directory: string; state: string; error: string; createdAt: number }
const attachments = () => backendApi().data.dataset<Attachment>('attachments')
const references = () => backendApi().data.dataset<Reference>('attachment_refs')
const cleanups = () => backendApi().data.dataset<Cleanup>('chat_cleanup')
const digest = (bytes: Uint8Array): string => bytesToHex(sha256(bytes))
export async function datasetRows<T extends DatasetRecord>(dataset: PluginDatasetApi<T>, where?: import('@valley/plugin-sdk/datasets').DatasetWhere): Promise<T[]> {
  const rows: T[] = []
  let cursor: string | undefined
  do { const page = await dataset.query({ where, limit: 500, cursor }); rows.push(...page.rows); cursor = page.cursor } while (cursor)
  return rows
}

async function location(record: Attachment) {
  if (!record.path.startsWith('.valley/plugins/data/assistant/attachment/')) fs.bindAttachmentFolder(record.path.includes('/blobs/') ? record.path.slice(0, record.path.lastIndexOf('/blobs/')) : path.dirname(path.dirname(record.path)))
  return fs.storageLocation(path.join(VAULT_ROOT, record.path))
}
async function readBytes(record: Attachment): Promise<Uint8Array> {
  const api = backendApi(), target = await location(record)
  let offset = 0
  const chunks: Uint8Array[] = []
  for (;;) {
    const part = await api.storage.readBytes(target, { offset, maxBytes: 1024 * 1024 })
    chunks.push(Uint8Array.from(atob(part.base64), char => char.charCodeAt(0)))
    if (chunks.reduce((sum, chunk) => sum + chunk.length, 0) > 32 * 1024 * 1024) throw new Error('Attachment read exceeded its limit')
    if (part.done) break
    if (part.nextOffset <= offset || part.nextOffset > 32 * 1024 * 1024) throw new Error('Attachment read exceeded its limit')
    offset = part.nextOffset
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

export async function importAttachment(input: { fileName: string; kind: InboundAttachment['kind']; mime?: string; bytes: Uint8Array; folder?: string }): Promise<InboundAttachment> {
  if (input.bytes.length > Math.min(32 * 1024 * 1024, (await effectiveSettings(VAULT_ROOT)).importMaxBytes)) throw new Error('Attachment exceeds the in-memory import limit. Use bounded file streaming for larger imports.')
  return runExclusive('attachment-ownership', async () => {
    const id = crypto.randomUUID()
    const detected = detectType(input.bytes, input.mime)
    const hash = digest(input.bytes)
    const folder = fs.bindAttachmentFolder(input.folder ?? String(backendApi().settings.get().attachmentFolder ?? ''))
    const file = path.join(folder, 'blobs', hash.slice(0, 2), hash)
    const staging = path.join(folder, 'staging', `${id}.part`)
    const record: Attachment = { id, path: path.relative(VAULT_ROOT, file), fileName: input.fileName, mime: detected.mime, kind: detected.kind,
      owned: true, sha256: hash, state: 'importing', createdAt: Date.now() }
    await attachments().insert(record)
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      const existing = await backendApi().storage.stat(await location(record))
      if (existing) {
        if (digest(await readBytes(record)) !== hash) throw new Error('Attachment blob integrity check failed; existing bytes preserved')
      } else {
        await fs.mkdir(path.dirname(staging), { recursive: true })
        await fs.atomicWriteFile(staging, input.bytes)
        await fs.rename(staging, file)
      }
      await attachments().update({ id }, { state: 'ready' })
    } catch (error) { await attachments().update({ id }, { state: 'pending-delete' }); throw error }
    return { id, path: record.path, kind: record.kind, fileName: record.fileName, mime: record.mime }
  })
}

export async function importAttachmentFile(input: { fileHandle: string; fileName: string; mime?: string; kind: InboundAttachment['kind']; folder?: string }): Promise<InboundAttachment> {
  const api = backendApi(), settings = await effectiveSettings(VAULT_ROOT)
  return runExclusive('attachment-ownership', async () => {
    const id = crypto.randomUUID(), folder = fs.bindAttachmentFolder(input.folder ?? settings.attachmentFolder)
    const staging = path.join(folder, 'staging', `${id}.part`)
    await fs.mkdir(path.dirname(staging), { recursive: true })
    const target = await fs.storageLocation(staging), hasher = sha256.create()
    let offset = 0, detected: ReturnType<typeof detectType> | undefined
    try {
      for (;;) {
        const part = await api.files.read(input.fileHandle, { offset, maxBytes: 1024 * 1024 })
        const bytes = Uint8Array.from(atob(part.base64), character => character.charCodeAt(0))
        if (offset + bytes.length > settings.importMaxBytes) throw new Error('Attachment exceeds the configured import limit')
        detected ??= detectType(bytes, input.mime)
        hasher.update(bytes)
        await api.storage.writeBytes(target, part.base64, offset > 0)
        if (!part.done && !bytes.length) throw new Error('Attachment stream stopped before completion')
        offset += bytes.length
        if (part.done) break
      }
      const hash = bytesToHex(hasher.digest()), file = path.join(folder, 'blobs', hash.slice(0, 2), hash)
      const record: Attachment = { id, path: path.relative(VAULT_ROOT, file), fileName: input.fileName, mime: detected!.mime, kind: detected!.kind, owned: true, sha256: hash, state: 'importing', createdAt: Date.now() }
      await attachments().insert(record)
      await fs.mkdir(path.dirname(file), { recursive: true })
      const destination = await location(record)
      if (!await api.storage.stat(destination)) await fs.rename(staging, file)
      else {
        const verify = sha256.create(); let position = 0
        for (;;) {
          const part = await api.storage.readBytes(destination, { offset: position, maxBytes: 1024 * 1024 })
          verify.update(Uint8Array.from(atob(part.base64), character => character.charCodeAt(0)))
          if (part.done) break
          if (part.nextOffset <= position || part.nextOffset > settings.importMaxBytes) throw new Error('Existing attachment integrity read exceeded its limit')
          position = part.nextOffset
        }
        if (bytesToHex(verify.digest()) !== hash) throw new Error('Existing attachment bytes changed; preserved without replacement')
        await fs.rm(staging, { force: true })
      }
      await attachments().update({ id }, { state: 'ready' })
      return { id, path: record.path, fileName: record.fileName, mime: record.mime, kind: record.kind }
    } catch (error) { await attachments().update({ id }, { state: 'pending-delete' }).catch(() => {}); throw error }
  })
}

export async function conversationAttachmentMetadata(id: string, chatId: string): Promise<{ attachment: Attachment; bytes: number }> {
  if (!await references().get({ attachmentId: id, chatId })) throw new Error('Attachment is not available to this conversation')
  const attachment = await attachments().get({ id })
  if (!attachment || attachment.state !== 'ready') throw new Error('Attachment is unavailable')
  const stat = await backendApi().storage.stat(await location(attachment))
  if (!stat || stat.kind !== 'file') throw new Error('Attachment file is unavailable')
  return { attachment, bytes: stat.size }
}

export async function findAttachment(file: string): Promise<Attachment | null> {
  const rows = await datasetRows(attachments(), { path: file, state: 'ready' })
  return rows[0] ?? null
}

export async function readConversationAttachment(id: string, chatId: string): Promise<{ attachment: Attachment; bytes: Uint8Array }> {
  if (!await references().get({ attachmentId: id, chatId })) throw new Error('Attachment is not available to this conversation')
  const attachment = await attachments().get({ id })
  if (!attachment || attachment.state !== 'ready') throw new Error('Attachment is unavailable')
  const bytes = await readBytes(attachment)
  if (digest(bytes) !== attachment.sha256) throw new Error('Attachment has changed; preserved without reading it into the model')
  return { attachment, bytes }
}

export async function listConversationAttachments(chatId: string): Promise<Attachment[]> {
  const refs = await datasetRows(references(), { chatId })
  const rows = await Promise.all(refs.map(ref => attachments().get({ id: ref.attachmentId })))
  return rows.filter((row): row is Attachment => row !== null && row.state === 'ready')
}
export async function openOwnedAttachment(file: string): Promise<import('@valley/plugin-sdk/pluginNative').PluginFileHandle | null> {
  const record = await findAttachment(file)
  if (!record) return null
  return backendApi().storage.exportFile(await location(record))
}

export async function assertChatWritable(chatId: string): Promise<void> {
  if (await cleanups().get({ id: chatId })) throw new Error('This conversation has been deleted')
}
export async function referenceAttachments(chatId: string, messages: AiMessage[]): Promise<void> {
  await runExclusive('attachment-ownership', async () => {
    await assertChatWritable(chatId)
    const ids = [...new Set(messages.flatMap(message => message.attachmentIds ?? []))]
    for (const id of ids) {
      const record = await attachments().get({ id })
      if (!record || record.state !== 'ready') throw new Error(`Attachment is unavailable: ${id}`)
    }
    if (ids.length) await references().upsert(ids.map(attachmentId => ({ attachmentId, chatId })))
  })
}

async function collectAttachment(record: Attachment): Promise<void> {
  if (await references().count({ attachmentId: record.id })) {
    await attachments().update({ id: record.id }, { state: 'ready' })
    return
  }
  await attachments().update({ id: record.id }, { state: 'pending-delete' })
  const shared = (await datasetRows(attachments(), { path: record.path })).some(other => other.id !== record.id)
  if (shared) { await attachments().delete({ id: record.id }); return }
  if (record.owned) {
    const api = backendApi(), target = await location(record)
    if (await api.storage.stat(target)) {
      if (digest(await readBytes(record)) !== record.sha256) throw new Error(`Attachment changed; preserved ${record.path}`)
      await api.storage.remove(target, { missingOk: true })
    }
    // Every managed upload gets its own UUID directory; never remove its parent.
    if (path.basename(path.dirname(record.path)) === record.id) await api.storage.remove({ ...target, path: path.dirname(target.path) }, { missingOk: true })
  }
  await attachments().delete({ id: record.id })
}

async function finishChatCleanup(cleanup: Cleanup): Promise<void> {
  await stopChatProcesses(cleanup.id, true)
  const refs = await datasetRows(references(), { chatId: cleanup.id })
  const errors: string[] = []
  for (const ref of refs) {
    try {
      const record = await attachments().get({ id: ref.attachmentId })
      if (record) await attachments().update({ id: record.id }, { state: 'pending-delete' })
      await references().delete({ attachmentId: ref.attachmentId, chatId: ref.chatId })
      if (record) await collectAttachment(record)
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
  }
  // An interrupted cleanup may already have removed the reference row.
  for (const record of await datasetRows(attachments(), { state: 'pending-delete' })) {
    try { await collectAttachment(record) } catch (error) { errors.push(String(error)) }
  }
  try {
    if (cleanup.directory) await fs.rm(cleanup.directory, { recursive: true, force: true })
  } catch (error) { errors.push(String(error)) }
  await cleanups().update({ id: cleanup.id }, { state: errors.length ? 'pending' : 'done', error: errors.join('\n') })
  if (errors.length) throw new Error(errors.join('\n'))
}
export async function markChatDeleting(id: string, directory: string): Promise<void> {
  await cleanups().upsert(await cleanups().get({ id }) ?? { id, directory, state: 'pending', error: '', createdAt: Date.now() })
}
export async function discardAttachment(id: string): Promise<void> {
  await runExclusive('attachment-ownership', async () => {
    const record = await attachments().get({ id })
    if (record) await collectAttachment(record)
  })
}
export async function deleteChatData(id: string, directory: string): Promise<void> {
  await runExclusive('attachment-ownership', async () => {
    const cleanup = await cleanups().get({ id }) ?? { id, directory, state: 'pending', error: '', createdAt: Date.now() }
    await cleanups().upsert(cleanup)
    await finishChatCleanup(cleanup)
  })
}
export async function resumeAttachmentCleanup(): Promise<void> {
  await runExclusive('attachment-ownership', async () => {
    const failures: string[] = []
    for (const cleanup of await datasetRows(cleanups(), { state: 'pending' })) {
      try { await finishChatCleanup(cleanup) } catch (error) { failures.push(String(error)) }
    }
    for (const record of await datasetRows(attachments(), { state: 'importing' })) {
      try { await collectAttachment(record) } catch (error) { failures.push(String(error)) }
    }
    for (const record of await datasetRows(attachments(), { state: 'pending-delete' })) {
      try { await collectAttachment(record) } catch (error) { failures.push(String(error)) }
    }
    if (failures.length) throw new Error(failures.join('\n'))
  })
}

export async function importTransferredAttachments(): Promise<void> {
  const file = path.join(VAULT_ROOT, '.valley/plugins/data/assistant/transfer-records.json')
  let text: string
  try { text = await fs.readFile(file) } catch (error) { if ((error as { code?: string }).code === 'ENOENT') return; throw error }
  const record = z.object({ id: z.string().uuid(), path: z.string().min(1).max(4096), fileName: z.string().max(4096), mime: z.string().max(256), kind: z.enum(['image', 'pdf', 'audio', 'file']), owned: z.literal(false), sha256: z.string().regex(/^[a-f0-9]{64}$/), state: z.literal('ready'), createdAt: z.number().finite() }).strict()
  const input = z.object({ version: z.literal(1), attachments: z.array(record).max(100000), references: z.array(z.object({ attachmentId: z.string().uuid(), chatId: z.string().min(1).max(256) }).strict()).max(500000) }).strict().parse(JSON.parse(text))
  const ids = new Set(input.attachments.map(item => item.id))
  if (ids.size !== input.attachments.length || input.references.some(ref => !ids.has(ref.attachmentId))) throw new Error('Invalid transferred attachment references')
  for (const item of input.attachments) {
    const existing = await attachments().get({ id: item.id })
    if (existing && (existing.path !== item.path || existing.sha256 !== item.sha256 || existing.owned)) throw new Error('Transferred attachment conflicts with an existing record')
    await attachments().upsert(item)
    const verified = await attachments().get({ id: item.id })
    if (!verified || verified.sha256 !== item.sha256 || verified.path !== item.path || verified.owned) throw new Error('Transferred attachment verification failed')
  }
  for (const ref of input.references) {
    await references().upsert(ref)
    if (!await references().get(ref)) throw new Error('Transferred attachment reference verification failed')
  }
  await fs.rm(file)
}
