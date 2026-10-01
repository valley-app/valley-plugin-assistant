import { z } from 'zod'
import { backendApi } from '../runtime'
import { runExclusive } from '../fileQueue'
import { readDocument, requireRevision, writeDocument, type ConfigurationApi } from './documents'
import { trySeed, writeSnapshot, configurationPath, contentHash, formatMarkdown, parseMarkdown, readOptional, relativeAssistantNote } from './markdown'
import { homeBody, instructionSeeds } from './seeds'

const link = z.string().trim().min(1).max(4096)
const instructionLinks = z.object({
  global: link.default(relativeAssistantNote('instructions/global.md')),
  vault: link.default(relativeAssistantNote('instructions/vault.md')),
  external: link.default(relativeAssistantNote('instructions/external.md')),
  tools: link.default(relativeAssistantNote('instructions/tools.md')),
  voice: link.default(relativeAssistantNote('instructions/voice.md')),
  plan: link.default(relativeAssistantNote('instructions/plan.md')),
  telegram: link.default(relativeAssistantNote('instructions/telegram.md')),
  whatsapp: link.default(relativeAssistantNote('instructions/whatsapp.md')),
  chatNaming: link.default(relativeAssistantNote('instructions/chat-naming.md')),
}).strict()

export const settingsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  showTelegram: z.boolean().default(true), showWhatsApp: z.boolean().default(true),
  sidebarChronological: z.boolean().default(false),
  telegramChronological: z.boolean().default(false), whatsappChronological: z.boolean().default(false),
  defaultProfileId: z.string().max(256).default('default'),
  defaultModel: z.string().max(512).default(''),
  attachmentParser: z.string().max(512).default('markitdown'),
  attachmentFolder: z.string().max(4096).refine(value => !value || !value.startsWith('/') && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..' && part !== '.valley'), 'Use a vault-relative attachment folder').default(''),
  sendOnEnter: z.boolean().default(true), showTimestamps: z.boolean().default(true),
  automaticChatNaming: z.boolean().default(true),
  importMaxBytes: z.number().int().min(1024).max(2 * 1024 * 1024 * 1024).default(32 * 1024 * 1024),
  commandReporting: z.enum(['context', 'descriptive', 'concise']).default('context'),
  instructions: instructionLinks.default({}),
}).strict()
export type MarkdownSettings = z.infer<typeof settingsSchema>
export interface SettingsDocument { revision: number; values: MarkdownSettings }
export const defaultMarkdownSettings = settingsSchema.parse({})

export interface ConfigurationDiagnostic { path: string; message: string; retained: boolean }
const diagnostics = new WeakMap<object, Map<string, ConfigurationDiagnostic>>()
export function reportConfigurationError(path: string, error: unknown, retained: boolean, owner: ConfigurationApi = backendApi()): void {
  const api = backendApi(), entries = diagnostics.get(api) ?? new Map<string, ConfigurationDiagnostic>()
  diagnostics.set(api, entries)
  const diagnostic = { path, message: error instanceof Error ? error.message : String(error), retained }
  if (JSON.stringify(entries.get(path)) !== JSON.stringify(diagnostic)) owner.rpc.emit('configuration.error', diagnostic)
  entries.set(path, diagnostic)
}
export function clearConfigurationError(path: string): void { diagnostics.get(backendApi())?.delete(path) }
export function configurationDiagnostics(): ConfigurationDiagnostic[] { return [...(diagnostics.get(backendApi())?.values() ?? [])] }

export async function ensureMarkdownConfiguration(root: string, api: ConfigurationApi = backendApi()): Promise<void> {
  return runExclusive(configurationPath(root, 'configuration-bootstrap'), async () => {
    const seeds: Array<[string, string]> = [['README.md', homeBody]]
    for (const [name, body] of Object.entries(instructionSeeds)) seeds.push([`instructions/${name}.md`, formatMarkdown({ includes: [] }, body)])
    for (const [relative, source] of seeds) {
      const file = configurationPath(root, relative)
      if (await readOptional(file, api) === null) await trySeed(file, source, api)
    }
    const file = configurationPath(root, 'settings.md')
    if (await readOptional(file, api) === null) {
      const legacy = api.settings.get()
      const allowed = Object.fromEntries(Object.keys(settingsSchema.shape).filter(key => key in legacy).map(key => [key, legacy[key]]))
      const settings = settingsSchema.parse(allowed)
      await trySeed(file, formatMarkdown(settings, '# Assistant settings\n\nEdit these values in Markdown. Linked instructions are compiled and validated before each turn. Credentials and permission grants are managed by core.'), api)
    }
  })
}

export async function effectiveSettings(root: string, api: ConfigurationApi = backendApi()): Promise<MarkdownSettings> {
  await ensureMarkdownConfiguration(root, api)
  const file = configurationPath(root, 'settings.md'), cache = configurationPath(root, 'runtime/configuration/settings.last-valid.json')
  try {
    const stored = await readOptional(file, api)
    const legacy = api.settings.get()
    const source = stored ?? formatMarkdown(settingsSchema.parse(Object.fromEntries(Object.keys(settingsSchema.shape).filter(key => key in legacy).map(key => [key, legacy[key]]))), '')
    const { metadata } = parseMarkdown(source, settingsSchema, relativeAssistantNote('settings.md'))
    await writeSnapshot(cache, { hash: contentHash(source), settings: metadata }, api)
    if (stored !== null) clearConfigurationError(file)
    return metadata
  } catch (error) {
    const previous = await readOptional(cache, api)
    let retained: MarkdownSettings | undefined
    if (previous) {
      try { retained = settingsSchema.parse(JSON.parse(previous).settings) } catch { /* an invalid cache is not a configuration */ }
    }
    reportConfigurationError(file, error, Boolean(retained), api)
    if (retained) return retained
    throw error
  }
}

export async function readSettingsDocument(root: string, api: ConfigurationApi = backendApi()): Promise<SettingsDocument> {
  await ensureMarkdownConfiguration(root, api)
  const file = configurationPath(root, 'settings.md'), document = await readDocument(file, api)
  if (!document.content) throw new Error('Assistant settings note is missing')
  return { revision: document.revision, values: parseMarkdown(document.content, settingsSchema, file).metadata }
}

export async function saveSettings(root: string, patch: Record<string, unknown>, expectedRevision: number, api: ConfigurationApi = backendApi()): Promise<MarkdownSettings> {
  requireRevision(expectedRevision)
  await ensureMarkdownConfiguration(root, api)
  const file = configurationPath(root, 'settings.md')
  const settings = await runExclusive(file, async () => {
    const document = await readDocument(file, api)
    if (!document.content) throw new Error('Assistant settings note is missing')
    if (document.revision !== expectedRevision) throw Object.assign(new Error('Assistant settings changed; reload before patching'), { code: 'REVISION_CONFLICT', outcome: 'not-applied', currentRevision: document.revision })
    const note = parseMarkdown(document.content, settingsSchema, file)
    const next = settingsSchema.parse({ ...note.metadata, ...patch })
    await writeDocument(file, formatMarkdown(next, note.body), expectedRevision, api)
    return next
  })
  api.rpc.emit('configuration.changed', { settings })
  return settings
}

export async function saveInstructionLink(root: string, key: keyof MarkdownSettings['instructions'], value: string, expectedRevision: number, api: ConfigurationApi = backendApi()): Promise<void> {
  const { noteReference, readInstructionNote } = await import('./markdown')
  const target = noteReference(value)
  await readInstructionNote(root, target, api)
  const settings = (await readSettingsDocument(root, api)).values
  await saveSettings(root, { instructions: { ...settings.instructions, [key]: target } }, expectedRevision, api)
}

export async function writeConfigurationNote(root: string, name: string, metadata: object, body: string, expectedRevision: number, api: ConfigurationApi = backendApi()): Promise<void> {
  await writeDocument(configurationPath(root, name), formatMarkdown(metadata, body), expectedRevision, api)
  api.rpc.emit('configuration.changed', { path: relativeAssistantNote(name) })
}
