import { readSpeechSettings } from './configuration/speech'
import { openOwnedAttachment, findAttachment } from './attachments'
import { readPdf } from './attachments/pdfPipeline'
import { visionReader } from './attachments/visualPipeline'
import { t } from './runtime'
import path from 'path-browserify'
import { backendApi } from './runtime'
import { guardFilePath } from './guards'
import { runSkill } from './skills'

export type IngestKind = 'image' | 'pdf' | 'audio' | 'file'

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf'
}

function mimeFor(relPath: string, kind: IngestKind): string {
  const ext = path.extname(relPath).toLowerCase()
  return MIME_BY_EXT[ext] || (kind === 'pdf' ? 'application/pdf' : 'image/jpeg')
}

async function readBytes(_root: string, relPath: string): Promise<Uint8Array<ArrayBuffer>> {
  const owned = await openOwnedAttachment(relPath)
  if (!owned) await guardFilePath(_root, relPath, 'read')
  const file = owned ?? await backendApi().files.openVault(relPath)
  const chunks: Uint8Array[] = []
  let offset = 0
  try {
    if (file.size > 32 * 1024 * 1024) throw new Error(t('assistant.backend.attachmentLimit'))
    for (;;) {
      const chunk = await backendApi().files.read(file.handle, { offset, maxBytes: 1024 * 1024 })
      const bytes = Uint8Array.from(atob(chunk.base64), (character) => character.charCodeAt(0))
      chunks.push(bytes); offset += bytes.length
      if (offset > 32 * 1024 * 1024) throw new Error(t('assistant.backend.attachmentLimit'))
      if (chunk.done) break
    }
    const result = new Uint8Array(offset)
    let position = 0
    for (const bytes of chunks) { result.set(bytes, position); position += bytes.length }
    return result
  } finally { await backendApi().files.release([file.handle]) }
}

export async function ingestAttachment(
  root: string,
  opts: { path: string; kind: IngestKind; parser?: string; startPage?: number; mode?: 'auto' | 'text' | 'visual'; signal?: AbortSignal }
): Promise<{ text: string; nextPage?: number; warnings?: string[] }> {
  if (opts.kind === 'pdf') return readPdf(await readBytes(root, opts.path), { ...opts, vision: await visionReader(opts.parser) })

  if (opts.kind === 'audio') {
    const metadata = await findAttachment(opts.path)
    const owned = await openOwnedAttachment(opts.path)
    if (!owned) await guardFilePath(root, opts.path, 'read')
    const file = owned ?? await backendApi().files.openVault(opts.path)
    try {
      const settings = await readSpeechSettings(root)
      const result = await backendApi().ai.speech.transcribe({ provider: settings.transcriptionProvider ?? settings.provider, connectionId: settings.transcriptionConnectionId ?? settings.connectionId, model: settings.transcriptionModel, fileHandle: file.handle, fileName: metadata?.fileName ?? path.basename(opts.path), mimeType: metadata?.mime })
      return { text: result.text }
    } finally { await backendApi().files.release([file.handle]) }
  }

  const vision = await visionReader(opts.parser)
  if (vision && opts.kind === 'image') {
    const bytes = await readBytes(root, opts.path)
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
    return { text: await vision(btoa(binary), 1, opts.signal, (await findAttachment(opts.path))?.mime ?? mimeFor(opts.path, opts.kind)) }
  }
  if (opts.parser && opts.parser !== 'markitdown') throw new Error('The configured vision connection is unavailable or does not support images')

  const text = await runSkill(root, 'markitdown', { path: opts.path })
  return { text }
}
