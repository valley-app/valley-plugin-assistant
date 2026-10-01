import { z } from 'zod'
import path from 'path-browserify'
import { backendApi } from '../runtime'
import type { ConfigurationApi } from './documents'
import { writeSnapshot, checkInstructionAccess, configurationPath, contentHash, noteReference, parseMarkdown, readInstructionNote, readOptional, relativeAssistantNote, utf8Size } from './markdown'
import { clearConfigurationError, configurationDiagnostics, effectiveSettings, reportConfigurationError } from './settings'

export const INSTRUCTION_LIMIT = 8192
const includeSchema = z.object({ includes: z.array(z.string().min(1).max(4096)).max(64).default([]) }).passthrough()
const scopeSchema = z.object({ conversationId: z.string().min(1).max(256), mode: z.enum(['plan', 'execute']), context: z.enum(['VAULT', 'EXTERNAL', 'MIXED']), profileId: z.string().max(256).optional(), source: z.enum(['telegram', 'whatsapp']).optional(), voice: z.boolean().optional(), channelInstruction: z.string().optional(), projectInstruction: z.string().optional(), conversationInstruction: z.string().optional(), channelReplacesPersonality: z.boolean().optional() }).strict()
export type InstructionScope = z.infer<typeof scopeSchema>
export interface InstructionBundle { text: string; hash: string; bytes: number; sources: Array<{ path: string; hash: string }>; scope: string; retained: boolean; error?: string }

export async function compileInstructionRoots(roots: string[], read: (path: string) => Promise<string>): Promise<Omit<InstructionBundle, 'scope' | 'retained'>> {
  const sources: InstructionBundle['sources'] = [], pieces: string[] = [], visiting = new Set<string>(), visited = new Set<string>()
  let bytes = 0
  const visit = async (reference: string, parent = '', depth = 0): Promise<void> => {
    const file = noteReference(reference, parent)
    if (visiting.has(file)) throw new Error(`Instruction include cycle: ${[...visiting, file].join(' → ')}`)
    if (visited.has(file)) return
    if (depth > 8 || visited.size + visiting.size >= 64) throw new Error(`Instruction include graph is too large at ${file}`)
    visiting.add(file)
    const source = await read(file), note = parseMarkdown(source, includeSchema, file)
    const piece = `## Instruction source: ${file}\n\n${note.body}`
    bytes += utf8Size(piece) + (pieces.length ? 2 : 0)
    if (bytes > INSTRUCTION_LIMIT) throw new Error(`Instruction bundle exceeds ${INSTRUCTION_LIMIT} UTF-8 bytes (${bytes}) at ${[...visiting].join(' → ')}`)
    pieces.push(piece)
    sources.push({ path: file, hash: contentHash(source) })
    for (const include of note.metadata.includes) await visit(include, file, depth + 1)
    visiting.delete(file); visited.add(file)
  }
  for (const root of roots) await visit(root)
  const text = pieces.join('\n\n')
  return { text, bytes: utf8Size(text), hash: contentHash(JSON.stringify({ text, sources })), sources }
}

export async function compileInstructions(root: string, input: InstructionScope, api: ConfigurationApi = backendApi()): Promise<InstructionBundle> {
  const scope = scopeSchema.parse(input), settings = await effectiveSettings(root, api)
  const roots = [settings.instructions.global]
  const rulesPath = configurationPath(root, 'rules')
  try {
    const fs = await import('../filesystem')
    for (const entry of (await fs.readdir(rulesPath, { withFileTypes: true }, api)).sort((a, b) => a.name.localeCompare(b.name))) if (entry.isFile() && entry.name.endsWith('.md')) roots.push(relativeAssistantNote(`rules/${entry.name}`))
  } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error }
  const profileId = scope.profileId || settings.defaultProfileId || 'default'
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(profileId) || profileId.includes('..')) throw new Error('Invalid personality reference')
  if (!scope.channelReplacesPersonality) {
    const { readPersonality } = await import('../store')
    if (!await readPersonality(root, profileId, api)) throw new Error(`Personality not found: ${profileId}`)
    roots.push(relativeAssistantNote(`personalities/${profileId}/instructions.md`))
  }
  if (scope.source) roots.push(settings.instructions[scope.source])
  if (scope.channelInstruction) roots.push(scope.channelInstruction)
  if (scope.projectInstruction) roots.push(scope.projectInstruction)
  if (scope.conversationInstruction) roots.push(scope.conversationInstruction)
  roots.push(settings.instructions.tools)
  if (scope.context !== 'EXTERNAL') roots.push(settings.instructions.vault)
  if (scope.context !== 'VAULT') roots.push(settings.instructions.external)
  if (scope.voice) roots.push(settings.instructions.voice)
  if (scope.mode === 'plan') roots.push(settings.instructions.plan)
  const key = contentHash(JSON.stringify({ root, ...scope, roots }))
  const file = configurationPath(root, `runtime/configuration/bundles/${key}.json`)
  try {
    const invalidSource = configurationDiagnostics().find(diagnostic => roots.some(reference => diagnostic.path === path.join(root, noteReference(reference))))
    if (invalidSource) throw new Error(invalidSource.message)
    const compiled = await compileInstructionRoots(roots, reference => readInstructionNote(root, reference, api))
    const bundle = { ...compiled, scope: key, retained: false }
    await writeSnapshot(file, bundle, api)
    clearConfigurationError(key)
    return bundle
  } catch (error) {
    let previous: InstructionBundle | undefined
    try {
      const source = await readOptional(file, api), parsed = source ? JSON.parse(source) as InstructionBundle : undefined
      if (parsed && parsed.scope === key && typeof parsed.text === 'string' && utf8Size(parsed.text) <= INSTRUCTION_LIMIT && Array.isArray(parsed.sources) && parsed.sources.every(item => typeof item.path === 'string' && typeof item.hash === 'string') && parsed.hash === contentHash(JSON.stringify({ text: parsed.text, sources: parsed.sources }))) previous = parsed
    } catch { /* invalid derived snapshots cannot activate */ }
    reportConfigurationError(key, error, Boolean(previous), api)
    if (!previous) throw error
    for (const source of previous.sources) await checkInstructionAccess(source.path, api)
    return { ...previous, retained: true, error: error instanceof Error ? error.message : String(error) }
  }
}

export function instructionPathForConversation(root: string, directory: string): string { return path.relative(root, path.join(directory, 'settings.md')) }
