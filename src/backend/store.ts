import { t } from './runtime'
import { z } from 'zod'
import { ensureMarkdownConfiguration, effectiveSettings, reportConfigurationError } from './configuration/settings'
import { trySeed, formatMarkdown, parseMarkdown, readOptional, readInstructionNote, relativeAssistantNote, configurationPath } from './configuration/markdown'
import { instructionSeeds, homeBody } from './configuration/seeds'
import { validatedNote } from './configuration/snapshots'
import { routingSchema, includesSchema } from './configuration/schemas'
import { readJson, readText } from './repositoryFiles'
import { normalizeCommands } from './commandConfig'
import * as fs from './filesystem'
import path from 'path-browserify'
import type { AiConnectionStatus, AiModelInfo, AiPersonality, AiProviderId, AiProviderStatus, AssistantConfig, CustomCommand, RoutingConfig } from '../types'
import { atomicWriteFile } from './filesystem'
import {
  chorusCommandsPath,
  isSafeName,
  personalitiesDir,
  personalityDir,
  readmePath,
  rulesDir
} from './paths'
import { readGuardPolicy } from './guards'
import { queuedWrite } from './fileQueue'
import { backendApi } from './runtime'

export { normalizeCommands } from './commandConfig'
export { listChats, readChat, saveChat, renameChat, setChatPinned, deleteChat, clearChat, readGuardOverrides, saveGuardOverrides } from './threads'
export { appendMemory, readMemory } from './memory'

// ── Defaults ───────────────────────────────────────────────────────────────

export const DEFAULT_ROUTING: RoutingConfig = {
  auto: true,
  default: { provider: 'anthropic', model: 'claude-opus-4-8' },
  fast: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  rules: [
    { label: 'Deep planning / hard problems', kind: 'plan', minComplexity: 4, provider: 'anthropic', model: 'claude-opus-4-8' },
    { label: 'Coding & tool-heavy work', kind: 'code', provider: 'anthropic', model: 'claude-opus-4-8' },
    { label: 'Quick questions / chit-chat', kind: 'quick', provider: 'anthropic', model: 'claude-haiku-4-5' }
  ]
}

const DEFAULT_INSTRUCTIONS = instructionSeeds.personality
const DEFAULT_README = homeBody

// ── Low-level read/write ─────────────────────────────────────────────────────

async function writeFileAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await atomicWriteFile(file, content)
}

/** Write any missing default files on first run. Never overwrites existing edits. */
export async function ensureScaffold(vaultRoot: string): Promise<void> {
  await ensureMarkdownConfiguration(vaultRoot)
  const seed: [string, string][] = [
    [readmePath(vaultRoot), DEFAULT_README],
    [path.join(rulesDir(vaultRoot), 'tone.md'), '# Tone\n\nBe concise and direct. Lead with the answer. No emojis unless asked.\n']
  ]
  for (const [file, content] of seed) {
    if ((await readOptional(file)) === null) await trySeed(file, content)
  }
  await readPersonality(vaultRoot, DEFAULT_PROFILE_ID)
}

export async function listConnections(_root: string): Promise<AiConnectionStatus[]> {
  const ai = backendApi().ai
  return Promise.all((await ai.connections()).filter(connection => connection.providerCapabilities.includes('chat')).map(async connection => {
    if (connection.requiresKey) return connection
    const requestId = crypto.randomUUID()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const models = await Promise.race([
        ai.models({ provider: connection.provider, connectionId: connection.id, requestId }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Local model discovery timed out')), 3000) })
      ])
      return { ...connection, models, configured: models.length > 0 }
    } catch { return { ...connection, models: [], configured: false } }
    finally { clearTimeout(timer); void ai.cancel(requestId).catch(() => {}) }
  }))
}
export async function readProviderStatus(root: string): Promise<AiProviderStatus[]> { return providerStatusFrom(await listConnections(root)) }
function providerStatusFrom(connections: AiConnectionStatus[]): AiProviderStatus[] {
  return [...new Set(connections.map(connection => connection.provider))].map(id => {
    const mine = connections.filter(connection => connection.provider === id)
    const primary = mine.find(connection => connection.configured) ?? mine[0]
    return { provider: id, configured: mine.some(connection => connection.configured), authMode: primary.authMode,
      authSources: primary.authSources, baseUrl: primary.baseUrl, models: primary.models, name: primary.providerName,
      description: primary.providerDescription, icon: primary.providerIcon, capabilities: primary.providerCapabilities }
  })
}

// ── Rules ────────────────────────────────────────────────────────────────────

async function readRules(vaultRoot: string): Promise<{ name: string; content: string }[]> {
  try {
    const files = await fs.readdir(rulesDir(vaultRoot))
    const rules: { name: string; content: string }[] = []
    for (const file of files.sort()) {
      if (!file.endsWith('.md')) continue
      const content = await readText(path.join(rulesDir(vaultRoot), file))
      if (content != null) rules.push({ name: file.replace(/\.md$/, ''), content })
    }
    return rules
  } catch {
    return []
  }
}

export async function writeRule(vaultRoot: string, name: string, content: string): Promise<void> {
  if (!isSafeName(name)) throw new Error(t('assistant.backend.invalidRule', { value: name }))
  await writeFileAtomic(path.join(rulesDir(vaultRoot), `${name}.md`), content)
}

// ── Personalities (plugins/data/assistant/personalities/<id>/) ────────────────────────
// Reusable profiles: name · default flag · instructions · routing.

export const DEFAULT_PROFILE_ID = 'default'

function profilePath(vaultRoot: string, id: string): string {
  return path.join(personalityDir(vaultRoot, id), 'profile.json')
}
function profileInstructionsPath(vaultRoot: string, id: string): string {
  return path.join(personalityDir(vaultRoot, id), 'instructions.md')
}
function profileRoutingPath(vaultRoot: string, id: string): string {
  return path.join(personalityDir(vaultRoot, id), 'routing.json')
}

const personalitySchema = z.object({
  schemaVersion: z.literal(1).default(1), id: z.string(), name: z.string().min(1), isDefault: z.boolean(), routing: routingSchema, includes: includesSchema
}).strict()

export async function readPersonality(vaultRoot: string, id: string): Promise<AiPersonality | null> {
  if (!isSafeName(id)) return null
  const file = profileInstructionsPath(vaultRoot, id)
  let source = await readOptional(file)
  const legacy = await readJson<{ id?: string; name?: string; isDefault?: boolean } | null>(profilePath(vaultRoot, id), null)
  if (!source && !legacy && id !== DEFAULT_PROFILE_ID) return null
  if (!source?.replace(/^\uFEFF/, '').startsWith('---')) {
    source = formatMarkdown({ schemaVersion: 1, id, name: legacy?.name || (id === DEFAULT_PROFILE_ID ? 'Default' : id), isDefault: legacy?.isDefault ?? id === DEFAULT_PROFILE_ID,
      routing: await readJson<RoutingConfig>(profileRoutingPath(vaultRoot, id), DEFAULT_ROUTING), includes: [] }, source ?? DEFAULT_INSTRUCTIONS)
    await trySeed(file, source)
  }
  const note = await validatedNote(vaultRoot, file, source, personalitySchema, metadata => { if (metadata.id !== id) throw new Error(`${file}: personality ID cannot change`) })
  const relative = path.relative(vaultRoot, file)
  return { ...note.metadata, instructions: note.body, instructionsPath: relative, routingPath: relative }
}

export async function listPersonalities(vaultRoot: string): Promise<AiPersonality[]> {
  let names: string[]
  try {
    names = (await fs.readdir(personalitiesDir(vaultRoot), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
  const out: AiPersonality[] = []
  for (const name of names.sort()) {
    const p = await readPersonality(vaultRoot, name)
    if (p) out.push(p)
  }
  // The default profile sorts first; everything else alphabetically.
  return out.sort((a, b) => (a.isDefault === b.isDefault ? a.name.localeCompare(b.name) : a.isDefault ? -1 : 1))
}

export async function savePersonality(vaultRoot: string, p: AiPersonality): Promise<void> {
  if (!isSafeName(p.id)) throw new Error(t('assistant.backend.invalidPersonality', { value: p.id }))
  if (p.isDefault) {
    for (const other of await listPersonalities(vaultRoot)) {
      if (other.id !== p.id && other.isDefault) await savePersonality(vaultRoot, { ...other, isDefault: false })
    }
  }
  const file = profileInstructionsPath(vaultRoot, p.id), source = await readOptional(file)
  const includes = source?.startsWith('---') ? parseMarkdown(source, personalitySchema, file).metadata.includes : []
  await queuedWrite(file, formatMarkdown(personalitySchema.parse({ schemaVersion: 1, id: p.id, name: p.name, isDefault: p.isDefault, routing: p.routing, includes }), p.instructions))
}

export async function deletePersonality(vaultRoot: string, id: string): Promise<void> {
  if (!isSafeName(id) || id === DEFAULT_PROFILE_ID) return // the default is never deletable
  await fs.rm(personalityDir(vaultRoot, id), { recursive: true, force: true })
}

// ── Overall custom commands (plugins/data/assistant/commands.json) ────────────────────
// User-defined slash-commands shared by every chat (narrowed by per-connection
// and per-chat command lists at dispatch time). Legible, hand-editable JSON.

const commandsIndexSchema = z.object({ commands: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/)).max(100) }).strict()
const commandNoteSchema = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/), description: z.string().optional(), includes: includesSchema }).strict()

export async function readCommands(vaultRoot: string): Promise<CustomCommand[]> {
  const index = configurationPath(vaultRoot, 'commands.md')
  let source = await readOptional(index)
  if (source === null) {
    const legacy = normalizeCommands(await readJson<unknown>(chorusCommandsPath(vaultRoot), []))
    try { await saveCommands(vaultRoot, legacy) }
    catch (error) { reportConfigurationError(index, error, false); return legacy }
    source = await readOptional(index)
  }
  const names = (await validatedNote(vaultRoot, index, source!, commandsIndexSchema)).metadata.commands
  const commands: CustomCommand[] = []
  for (const name of names) {
    const file = configurationPath(vaultRoot, `commands/${name}.md`), text = await readOptional(file)
    if (text === null) throw new Error(`${file}: command note is missing`)
    const note = await validatedNote(vaultRoot, file, text, commandNoteSchema, (metadata, body) => { if (metadata.name !== name || !body.trim()) throw new Error(`${file}: command name or prompt is invalid`) })
    let prompt = note.body
    if (note.metadata.includes.length) {
      const { compileInstructionRoots } = await import('./configuration/instructions')
      const reference = relativeAssistantNote(`commands/${name}.md`)
      prompt = (await compileInstructionRoots([reference], target => target === reference ? Promise.resolve(note.source) : readInstructionNote(vaultRoot, target))).text
    }
    commands.push({ name, ...(note.metadata.description ? { description: note.metadata.description } : {}), prompt })
  }
  return normalizeCommands(commands)
}

export async function saveCommands(vaultRoot: string, commands: CustomCommand[]): Promise<void> {
  const clean = normalizeCommands(commands)
  for (const command of clean) {
    const file = configurationPath(vaultRoot, `commands/${command.name}.md`), source = await readOptional(file)
    const includes = source ? parseMarkdown(source, commandNoteSchema, file).metadata.includes : []
    await queuedWrite(file, formatMarkdown({ name: command.name, description: command.description, includes }, command.prompt))
  }
  const index = configurationPath(vaultRoot, 'commands.md'), source = await readOptional(index)
  await queuedWrite(index, formatMarkdown({ commands: clean.map(command => command.name) }, source ? parseMarkdown(source, commandsIndexSchema, index).body : '# Custom commands\n\nEach command links to commands/<name>.md. Edit its body for the prompt and frontmatter for its name and description. Removed command notes remain recoverable.'))
}

// ── Config (aggregate) ───────────────────────────────────────────────────────

export async function readConfig(vaultRoot: string): Promise<AssistantConfig> {
  await ensureScaffold(vaultRoot)
  const [instructions, rules, routing, guard, connections] = await Promise.all([
    effectiveSettings(vaultRoot).then(settings => readPersonality(vaultRoot, settings.defaultProfileId || DEFAULT_PROFILE_ID)).then(profile => profile?.instructions ?? DEFAULT_INSTRUCTIONS),
    readRules(vaultRoot),
    effectiveSettings(vaultRoot).then(settings => readPersonality(vaultRoot, settings.defaultProfileId || DEFAULT_PROFILE_ID)).then(profile => profile?.routing ?? DEFAULT_ROUTING),
    readGuardPolicy(vaultRoot),
    listConnections(vaultRoot)
  ])
  // `providers` is derived from the same snapshot rather than re-read, so the two
  // views can never disagree about what is configured.
  return { defaultHarness: 'deepseek', instructions, rules, routing, guard, connections, providers: providerStatusFrom(connections) }
}

export async function saveInstructions(vaultRoot: string, content: string): Promise<void> {
  const settings = await effectiveSettings(vaultRoot)
  const profile = await readPersonality(vaultRoot, settings.defaultProfileId || DEFAULT_PROFILE_ID)
  if (profile) await savePersonality(vaultRoot, { ...profile, instructions: content })
}
