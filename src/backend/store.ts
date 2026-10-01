import { t } from './runtime'
import { z } from 'zod'
import { ensureMarkdownConfiguration, effectiveSettings, settingsSchema } from './configuration/settings'
import { trySeed, formatMarkdown, parseMarkdown, readOptional, readInstructionNote, relativeAssistantNote, configurationPath } from './configuration/markdown'
import { instructionSeeds, homeBody } from './configuration/seeds'
import { validatedNote } from './configuration/snapshots'
import { routingSchema, includesSchema } from './configuration/schemas'
import { readJson } from './repositoryFiles'
import { normalizeCommands } from './commandConfig'
import * as fs from './filesystem'
import path from 'path-browserify'
import type { AiConnectionStatus, AiModelInfo, AiPersonality, AiProviderId, AiProviderStatus, AssistantConfig, CustomCommand, RoutingConfig } from '../types'
import {
  chorusCommandsPath,
  isSafeName,
  personalitiesDir,
  personalityDir,
  readmePath,
  rulesDir
} from './paths'
import { readGuardPolicy } from './guards'
import { readDocument, writeDocument, writeDocuments, requireRevision, type ConfigurationApi } from './configuration/documents'
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

/** Write any missing default files on first run. Never overwrites existing edits. */
export async function ensureScaffold(vaultRoot: string, api?: ConfigurationApi): Promise<void> {
  await ensureMarkdownConfiguration(vaultRoot, api)
  const seed: [string, string][] = [
    [readmePath(vaultRoot), DEFAULT_README],
    [path.join(rulesDir(vaultRoot), 'tone.md'), '# Tone\n\nBe concise and direct. Lead with the answer. No emojis unless asked.\n']
  ]
  for (const [file, content] of seed) {
    if ((await readOptional(file, api)) === null) await trySeed(file, content, api)
  }
  if (api) {
    const file = profileInstructionsPath(vaultRoot, DEFAULT_PROFILE_ID), document = await readDocument(file, api)
    if (!document.content && document.revision === 0) await writeDocument(file, formatMarkdown({ schemaVersion: 1, id: DEFAULT_PROFILE_ID, name: 'Default', isDefault: true, routing: DEFAULT_ROUTING, includes: [] }, DEFAULT_INSTRUCTIONS), document.revision, api)
  } else await readPersonality(vaultRoot, DEFAULT_PROFILE_ID)
}

export async function listConnections(_root: string, api: ConfigurationApi = backendApi()): Promise<AiConnectionStatus[]> {
  const ai = api.ai
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
export async function readProviderStatus(root: string, api: ConfigurationApi = backendApi()): Promise<AiProviderStatus[]> { return providerStatusFrom(await listConnections(root, api)) }
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

export async function readRules(vaultRoot: string, api?: ConfigurationApi): Promise<{ name: string; content: string; configurationRevision: number }[]> {
  try {
    const location = api ? await fs.documentLocation(rulesDir(vaultRoot), 'read', api) : undefined
    const files = location ? await api!.storage.list(location).then(entries => entries.map(entry => entry.name)).finally(() => api!.storage.close(location.handle)) : await fs.readdir(rulesDir(vaultRoot))
    const rules: { name: string; content: string; configurationRevision: number }[] = []
    for (const file of files.sort()) {
      if (!file.endsWith('.md')) continue
      const document = await readDocument(path.join(rulesDir(vaultRoot), file), api)
      if (document.content) rules.push({ name: file.replace(/\.md$/, ''), content: document.content, configurationRevision: document.revision })
    }
    return rules
  } catch (error) {
    if (api && (error as { code?: string }).code !== 'ENOENT') throw error
    return []
  }
}

export async function writeRule(vaultRoot: string, name: string, content: string, expectedRevision: number, api?: ConfigurationApi): Promise<void> {
  if (!isSafeName(name)) throw new Error(t('assistant.backend.invalidRule', { value: name }))
  await writeDocument(path.join(rulesDir(vaultRoot), `${name}.md`), content, expectedRevision, api)
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

export const personalitySchema = z.object({
  schemaVersion: z.literal(1).default(1), id: z.string(), name: z.string().min(1), isDefault: z.boolean(), routing: routingSchema, includes: includesSchema
}).strict()

export async function readPersonality(vaultRoot: string, id: string, api?: ConfigurationApi): Promise<AiPersonality | null> {
  if (!isSafeName(id)) return null
  const file = profileInstructionsPath(vaultRoot, id)
  let document = await readDocument(file, api)
  let source = document.content || null
  if (!source && (api || document.revision > 0)) return null
  const legacy = api ? null : await readJson<{ id?: string; name?: string; isDefault?: boolean } | null>(profilePath(vaultRoot, id), null)
  if (!source && !legacy && id !== DEFAULT_PROFILE_ID) return null
  if (!source?.replace(/^\uFEFF/, '').startsWith('---')) {
    source = formatMarkdown({ schemaVersion: 1, id, name: legacy?.name || (id === DEFAULT_PROFILE_ID ? 'Default' : id), isDefault: legacy?.isDefault ?? id === DEFAULT_PROFILE_ID,
      routing: await readJson<RoutingConfig>(profileRoutingPath(vaultRoot, id), DEFAULT_ROUTING), includes: [] }, source ?? DEFAULT_INSTRUCTIONS)
    if (!document.content) { await writeDocument(file, source, document.revision, api); document = await readDocument(file, api) }
  }
  const note = api ? parseMarkdown(source!, personalitySchema, file) : await validatedNote(vaultRoot, file, source!, personalitySchema, metadata => { if (metadata.id !== id) throw new Error(`${file}: personality ID cannot change`) })
  if (note.metadata.id !== id) throw new Error(`${file}: personality ID cannot change`)
  const relative = path.relative(vaultRoot, file)
  return { ...note.metadata, configurationRevision: document.revision, instructions: note.body, instructionsPath: relative, routingPath: relative }
}

export async function listPersonalities(vaultRoot: string, api?: ConfigurationApi): Promise<AiPersonality[]> {
  let names: string[]
  try {
    const location = api ? await fs.documentLocation(personalitiesDir(vaultRoot), 'read', api) : undefined
    names = location ? await api!.storage.list(location).then(entries => entries.filter(entry => entry.kind === 'directory').map(entry => entry.name)).finally(() => api!.storage.close(location.handle)) : (await fs.readdir(personalitiesDir(vaultRoot), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch (error) {
    if (api && (error as { code?: string }).code !== 'ENOENT') throw error
    return []
  }
  const out: AiPersonality[] = []
  for (const name of names.sort()) {
    const p = await readPersonality(vaultRoot, name, api)
    if (p) out.push(p)
  }
  const settingsRevision = (await readDocument(configurationPath(vaultRoot, 'settings.md'), api)).revision
  const revisions = Object.fromEntries(out.map(profile => [profile.id, profile.configurationRevision!]))
  for (const profile of out) profile.configurationRevisions = { ...revisions, 'settings.md': settingsRevision }
  // The default profile sorts first; everything else alphabetically.
  return out.sort((a, b) => (a.isDefault === b.isDefault ? a.name.localeCompare(b.name) : a.isDefault ? -1 : 1))
}

export async function savePersonality(vaultRoot: string, p: AiPersonality, api?: ConfigurationApi): Promise<void> {
  if (!isSafeName(p.id)) throw new Error(t('assistant.backend.invalidPersonality', { value: p.id }))
  requireRevision(p.configurationRevision)
  const current = await readPersonality(vaultRoot, p.id, api)
  const promoting = p.isDefault && !current?.isDefault
  const defaults = promoting ? (await listPersonalities(vaultRoot, api)).filter(other => other.id !== p.id && other.isDefault) : []
  const profiles = [p, ...defaults.map(other => ({ ...other, isDefault: false, configurationRevision: p.configurationRevisions?.[other.id] }))]
  const notes = await Promise.all(profiles.map(async profile => {
    requireRevision(profile.configurationRevision)
    const file = profileInstructionsPath(vaultRoot, profile.id), document = await readDocument(file, api)
    const includes = document.content.startsWith('---') ? parseMarkdown(document.content, personalitySchema, file).metadata.includes : []
    return { file, content: formatMarkdown(personalitySchema.parse({ schemaVersion: 1, id: profile.id, name: profile.name, isDefault: profile.isDefault, routing: profile.routing, includes }), profile.instructions), expectedRevision: profile.configurationRevision }
  }))
  if (promoting) {
    const expectedRevision = p.configurationRevisions?.['settings.md']; requireRevision(expectedRevision)
    const file = configurationPath(vaultRoot, 'settings.md'), document = await readDocument(file, api)
    const note = document.content ? parseMarkdown(document.content, settingsSchema, file) : { metadata: settingsSchema.parse({}), body: '# Assistant settings' }
    notes.push({ file, content: formatMarkdown({ ...note.metadata, defaultProfileId: p.id }, note.body), expectedRevision })
  }
  await writeDocuments(notes, api)
}

export async function deletePersonality(vaultRoot: string, id: string, expectedRevision: number, api?: ConfigurationApi): Promise<void> {
  if (!isSafeName(id) || id === DEFAULT_PROFILE_ID) return
  requireRevision(expectedRevision)
  await writeDocument(profileInstructionsPath(vaultRoot, id), null, expectedRevision, api)
}

// ── Overall custom commands (plugins/data/assistant/commands.json) ────────────────────
// User-defined slash-commands shared by every chat (narrowed by per-connection
// and per-chat command lists at dispatch time). Legible, hand-editable JSON.

export const commandsIndexSchema = z.object({ commands: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/)).max(100) }).strict()
export const commandNoteSchema = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/), description: z.string().optional(), includes: includesSchema }).strict()

export async function readCommands(vaultRoot: string, api?: ConfigurationApi): Promise<CustomCommand[]> {
  const { commands } = await readCommandsSnapshot(vaultRoot, api)
  if (!api) return commands
  const { compileInstructionRoots } = await import('./configuration/instructions')
  return Promise.all(commands.map(async command => {
    const relative = `commands/${command.name}.md`, reference = relativeAssistantNote(relative)
    return { ...command, prompt: (await compileInstructionRoots([reference], target => readInstructionNote(vaultRoot, target, api))).text }
  }))
}

export async function readCommandsSnapshot(vaultRoot: string, api?: ConfigurationApi): Promise<{ commands: CustomCommand[]; configurationRevisions: Record<string, number> }> {
  const index = configurationPath(vaultRoot, 'commands.md')
  let document = await readDocument(index, api)
  if (api && !document.content) return { commands: [], configurationRevisions: { 'commands.md': document.revision } }
  if (!document.content) {
    const legacy = normalizeCommands(await readJson<unknown>(chorusCommandsPath(vaultRoot), []))
    const revisions = { 'commands.md': document.revision } as Record<string, number>
    for (const command of legacy) { const relative = `commands/${command.name}.md`; revisions[relative] = (await readDocument(configurationPath(vaultRoot, relative), api)).revision }
    await saveCommands(vaultRoot, legacy, revisions, api)
    document = await readDocument(index, api)
  }
  const names = (api ? parseMarkdown(document.content, commandsIndexSchema, index) : await validatedNote(vaultRoot, index, document.content, commandsIndexSchema)).metadata.commands
  const configurationRevisions: Record<string, number> = { 'commands.md': document.revision }
  const commands: CustomCommand[] = []
  for (const name of names) {
    const relative = `commands/${name}.md`, file = configurationPath(vaultRoot, relative), document = await readDocument(file, api)
    if (!document.content) throw new Error(`${file}: command note is missing`)
    configurationRevisions[relative] = document.revision
    const note = api ? { ...parseMarkdown(document.content, commandNoteSchema, file), source: document.content } : await validatedNote(vaultRoot, file, document.content, commandNoteSchema, (metadata, body) => { if (metadata.name !== name || !body.trim()) throw new Error(`${file}: command name or prompt is invalid`) })
    if (note.metadata.name !== name || !note.body.trim()) throw new Error(`${file}: command name or prompt is invalid`)
    let prompt = note.body
    if (!api && note.metadata.includes.length) {
      const { compileInstructionRoots } = await import('./configuration/instructions')
      const reference = relativeAssistantNote(relative)
      prompt = (await compileInstructionRoots([reference], target => target === reference ? Promise.resolve(note.source) : readInstructionNote(vaultRoot, target))).text
    }
    commands.push({ name, ...(note.metadata.description ? { description: note.metadata.description } : {}), prompt })
  }
  return { commands: normalizeCommands(commands), configurationRevisions }
}

export async function saveCommands(vaultRoot: string, commands: CustomCommand[], expectedRevisions: Record<string, number>, api?: ConfigurationApi): Promise<void> {
  const clean = normalizeCommands(commands)
  const index = configurationPath(vaultRoot, 'commands.md'), document = await readDocument(index, api)
  const expectedRevision = expectedRevisions?.['commands.md']; requireRevision(expectedRevision)
  const prior = document.content ? parseMarkdown(document.content, commandsIndexSchema, index) : null
  const notes = await Promise.all(clean.map(async command => {
    const relative = `commands/${command.name}.md`, file = configurationPath(vaultRoot, relative), document = await readDocument(file, api)
    const expectedRevision = expectedRevisions?.[relative] ?? (!prior?.metadata.commands.includes(command.name) && !document.content ? document.revision : undefined)
    requireRevision(expectedRevision)
    const includes = document.content ? parseMarkdown(document.content, commandNoteSchema, file).metadata.includes : []
    return { file, content: formatMarkdown({ name: command.name, description: command.description, includes }, command.prompt), expectedRevision }
  }))
  for (const name of prior?.metadata.commands.filter(name => !clean.some(command => command.name === name)) ?? []) {
    const relative = `commands/${name}.md`, file = configurationPath(vaultRoot, relative)
    const expectedRevision = expectedRevisions?.[relative]; requireRevision(expectedRevision)
    notes.push({ file, content: (await readDocument(file, api)).content, expectedRevision })
  }
  notes.push({ file: index, content: formatMarkdown({ commands: clean.map(command => command.name) }, prior?.body ?? '# Custom commands\n\nEach command links to commands/<name>.md. Edit its body for the prompt and frontmatter for its name and description. Removed command notes remain recoverable.'), expectedRevision })
  await writeDocuments(notes, api)
}

// ── Config (aggregate) ───────────────────────────────────────────────────────

export async function readConfig(vaultRoot: string, api?: ConfigurationApi): Promise<AssistantConfig> {
  if (!api) await ensureScaffold(vaultRoot)
  const settings = api ? await readDocument(configurationPath(vaultRoot, 'settings.md'), api).then(document => document.content ? parseMarkdown(document.content, settingsSchema, 'settings.md').metadata : settingsSchema.parse({})) : await effectiveSettings(vaultRoot)
  const profile = await readPersonality(vaultRoot, settings.defaultProfileId || DEFAULT_PROFILE_ID, api)
  const [instructions, rules, routing, guard, connections] = await Promise.all([
    Promise.resolve(profile?.instructions ?? DEFAULT_INSTRUCTIONS),
    readRules(vaultRoot, api),
    Promise.resolve(profile?.routing ?? DEFAULT_ROUTING),
    readGuardPolicy(vaultRoot, api),
    listConnections(vaultRoot, api)
  ])
  // `providers` is derived from the same snapshot rather than re-read, so the two
  // views can never disagree about what is configured.
  return { defaultHarness: 'deepseek', instructions, rules, routing, guard, connections, providers: providerStatusFrom(connections) }
}

export async function saveInstructions(vaultRoot: string, content: string, expectedRevision: number, api?: ConfigurationApi): Promise<void> {
  requireRevision(expectedRevision)
  const settings = await effectiveSettings(vaultRoot, api)
  const profile = await readPersonality(vaultRoot, settings.defaultProfileId || DEFAULT_PROFILE_ID, api)
  if (profile) await savePersonality(vaultRoot, { ...profile, instructions: content, configurationRevision: expectedRevision }, api)
}
