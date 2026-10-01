import path from 'path-browserify'
import { parseDocument, stringify } from 'yaml'
import { z } from 'zod'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import * as fs from '../filesystem'
import { backendApi } from '../runtime'
import { assistantDir } from '../paths'
import { readDocument, writeDocument, type ConfigurationApi } from './documents'

export const NOTE_LIMIT = 64 * 1024
export const utf8Size = (text: string): number => new TextEncoder().encode(text).length
export const contentHash = (text: string): string => bytesToHex(sha256(new TextEncoder().encode(text)))

export function parseMarkdown<S extends z.ZodTypeAny>(text: string, schema: S, file = 'Markdown note'): { metadata: z.output<S>; body: string } {
  if (utf8Size(text) > NOTE_LIMIT) throw new Error(`${file}: note exceeds ${NOTE_LIMIT} UTF-8 bytes`)
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(source)
  if (source.startsWith('---\n') && !match) throw new Error(`${file}: unclosed YAML frontmatter`)
  let metadata: unknown = {}
  if (match) {
    const document = parseDocument(match[1], { uniqueKeys: true, strict: true })
    if (document.errors.length) throw new Error(`${file}: ${document.errors[0].message}`)
    metadata = document.toJS({ maxAliasCount: 0 }) ?? {}
  }
  const parsed = schema.safeParse(metadata)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`${file}: ${issue.path.join('.') || 'frontmatter'}: ${issue.message}`)
  }
  return { metadata: parsed.data, body: source.slice(match?.[0].length ?? 0).trim() }
}

export function formatMarkdown(metadata: object, body: string): string {
  return `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.trim()}\n`
}

export function noteReference(reference: string, parent = ''): string {
  let value = reference.trim()
  if (value.startsWith('[[') && value.endsWith(']]')) value = value.slice(2, -2).split('|')[0]
  else {
    const link = /^\[[^\]]*\]\(([^)]+)\)$/.exec(value)
    if (link) value = link[1]
  }
  if (!value || value.includes('\\') || value.includes('\0') || value.includes('#') || /^[a-z]+:/i.test(value) || value.startsWith('/')) throw new Error(`Invalid instruction note link: ${reference}`)
  const resolved = path.normalize(value.startsWith('./') || value.startsWith('../') ? path.join(path.dirname(parent), value) : value)
  if (resolved === '..' || resolved.startsWith('../')) throw new Error(`Instruction note escapes the vault: ${reference}`)
  const result = resolved.endsWith('.md') ? resolved : `${resolved}.md`
  if (result.startsWith('.valley/') && !result.startsWith('.valley/plugins/data/assistant/')) throw new Error('Instruction notes cannot read another plugin’s metadata')
  return result
}

export async function readOptional(file: string, api: ConfigurationApi = backendApi()): Promise<string | null> {
  try { return await fs.readFile(file, 'utf8', api) }
  catch (error) { if ((error as { code?: string }).code === 'ENOENT') return null; throw error }
}

export async function readInstructionNote(root: string, reference: string, api: ConfigurationApi = backendApi()): Promise<string> {
  const relative = noteReference(reference)
  if (relative.startsWith('.valley/plugins/data/assistant/')) {
    const result = await fs.stat(path.join(root, relative), api)
    if (!result.isFile() || result.size > NOTE_LIMIT) throw new Error(`${relative}: expected a Markdown file of at most ${NOTE_LIMIT} bytes`)
    return fs.readFile(path.join(root, relative), 'utf8', api)
  }
  await checkInstructionAccess(relative, api)
  const grant = await api.storage.open({ area: 'vault', path: relative, kind: 'file', mode: 'read' })
  try {
    const location = { handle: grant.handle, path: '' }
    const stat = await api.storage.stat(location)
    if (!stat || stat.kind !== 'file' || stat.size > NOTE_LIMIT) throw new Error(`${relative}: missing or oversized instruction note`)
    const chunk = await api.storage.readBytes(location, { maxBytes: NOTE_LIMIT + 1 })
    if (!chunk.done) throw new Error(`${relative}: instruction note is too large`)
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(chunk.base64), char => char.charCodeAt(0)))
  } finally { await api.storage.close(grant.handle) }
}

export async function readInstructionDocument(root: string, reference: string, api: ConfigurationApi = backendApi()): Promise<{ content: string; revision: number }> {
  const relative = noteReference(reference)
  if (relative.startsWith('.valley/plugins/data/assistant/')) return readDocument(path.join(root, relative), api)
  await checkInstructionAccess(relative, api)
  const grant = await api.storage.open({ area: 'vault', path: relative, kind: 'file', mode: 'read' })
  try { return await api.storage.readDocument({ handle: grant.handle, path: '' }) } finally { await api.storage.close(grant.handle) }
}

export async function writeInstructionDocument(root: string, reference: string, content: string, expectedRevision: number, api: ConfigurationApi = backendApi()): Promise<{ revision: number }> {
  const relative = noteReference(reference)
  if (relative.startsWith('.valley/plugins/data/assistant/')) return writeDocument(path.join(root, relative), content, expectedRevision, api)
  await api.policy.checkFile(relative, 'write')
  const grant = await api.storage.open({ area: 'vault', path: relative, kind: 'file', mode: 'write' })
  try { return await api.storage.writeDocument({ handle: grant.handle, path: '' }, { content, expectedRevision }) } finally { await api.storage.close(grant.handle) }
}

export async function checkInstructionAccess(reference: string, api: ConfigurationApi = backendApi()): Promise<void> {
  const relative = noteReference(reference)
  if (!relative.startsWith('.valley/plugins/data/assistant/')) await api.policy.checkFile(relative, 'read')
}

export const relativeAssistantNote = (name: string): string => `.valley/plugins/data/assistant/${name}`
export const configurationPath = (root: string, name: string): string => path.join(assistantDir(root), name)

export async function trySeed(file: string, content: string, api: ConfigurationApi = backendApi()): Promise<boolean> {
  try {
    const current = await readDocument(file, api)
    if (current.content) return false
    await writeDocument(file, content, current.revision, api)
    return true
  }
  catch (error) {
    const { reportConfigurationError } = await import('./settings')
    reportConfigurationError(file, error, false, api)
    return false
  }
}

export async function writeSnapshot(file: string, value: unknown, api: ConfigurationApi = backendApi()): Promise<void> {
  const { runExclusive } = await import('../fileQueue')
  const { clearConfigurationError, reportConfigurationError } = await import('./settings')
  try {
    await runExclusive(file, async () => {
      const content = JSON.stringify(value, null, 2)
      if (await readOptional(file, api) !== content) await fs.atomicWriteFile(file, content, api)
    }, api)
    clearConfigurationError(file)
  } catch (error) { reportConfigurationError(file, error, false, api) }
}
