import { z } from 'zod'
import { ensureScaffold, readCommands } from '../store'
import { readChat } from '../threads'
import { channelConfigurationNote } from './channels'
import { projectConfigurationNote } from './conversations'
import { configurationPath, contentHash, formatMarkdown, noteReference, parseMarkdown, readInstructionDocument, writeInstructionDocument, readInstructionNote, relativeAssistantNote } from './markdown'
import { configurationDiagnostics, effectiveSettings, readSettingsDocument, saveInstructionLink, saveSettings } from './settings'
import { readSpeechSettings, readSpeechDocument, saveSpeechSettings } from './speech'
import { includesSchema, speechSchema, conversationSettingsSchema } from './schemas'
import { compileInstructionRoots } from './instructions'
import { runExclusive } from '../fileQueue'
import { backendApi } from '../runtime'
import { readDocument, writeDocument, type ConfigurationApi } from './documents'

export interface ConfigurationNote { id: string; group: 'instructions' | 'files'; path: string; key?: string }
export interface ConfigurationStatus { settingsRevision?: number; notes: ConfigurationNote[]; diagnostics: ReturnType<typeof configurationDiagnostics> }
const target = z.object({ scope: z.enum(['settings', 'instructions', 'chat', 'channel', 'conversation', 'project']).default('settings'), id: z.string().max(256).optional() }).strict()
const noteTarget = target.extend({ noteId: z.string().max(64) })
const instructionMetadata = z.object({ includes: includesSchema }).passthrough()
export interface ConfigurationDraft { revision: number; settingsRevision?: number; path: string; body: string; includes: string[]; hash: string }

export async function configurationStatus(root: string, input: unknown = {}, api: ConfigurationApi = backendApi()): Promise<ConfigurationStatus> {
  const request = target.parse(input)
  await ensureScaffold(root, api)
  const settings = await effectiveSettings(root, api)
  let notes: ConfigurationNote[] = []
  if (request.scope === 'conversation') {
    const thread = request.id ? await readChat(root, request.id, api) : null
    if (!thread?.instructionsPath) throw new Error('Conversation configuration is unavailable')
    notes = [{ id: 'conversation', group: 'instructions', path: thread.instructionsPath }]
  } else if (request.scope === 'project') {
    if (!request.id) throw new Error('Project identity is required')
    const project = await api.data.dataset('projects').get({ id: request.id })
    if (!project || project.deleting) throw new Error('Project is unavailable')
    notes = [{ id: 'project', group: 'instructions', path: relativeAssistantNote(projectConfigurationNote(request.id)) }]
  } else if (request.scope === 'channel') {
    if (!request.id) throw new Error('Connection identity is required')
    notes = [{ id: 'channel', group: 'instructions', path: relativeAssistantNote(channelConfigurationNote(request.id)) }]
  } else {
    await Promise.all([readSpeechSettings(root, api), readCommands(root, api)])
    notes = request.scope === 'instructions' ? Object.entries(settings.instructions).map(([key, value]) => ({ id: key, group: 'instructions' as const, key, path: noteReference(value) })) : request.scope === 'chat' ? [
      { id: 'defaults', group: 'files', path: relativeAssistantNote('settings.md') },
      { id: 'chatNaming', group: 'instructions', key: 'chatNaming', path: noteReference(settings.instructions.chatNaming) },
    ] : [
      { id: 'home', group: 'files', path: relativeAssistantNote('README.md') },
      { id: 'commands', group: 'files', path: relativeAssistantNote('commands.md') },
      ...Object.entries(settings.instructions).filter(([key]) => key !== 'chatNaming').map(([key, value]) => ({ id: key, group: 'instructions' as const, key, path: noteReference(value) })),
    ]
  }
  return { notes, diagnostics: configurationDiagnostics(), settingsRevision: await readSettingsDocument(root, api).then(value => value.revision).catch(() => undefined) }
}

async function configurationNote(root: string, input: z.infer<typeof noteTarget>, api: ConfigurationApi) {
  const status = await configurationStatus(root, { scope: input.scope, id: input.id }, api)
  const note = status.notes.find(note => note.id === input.noteId && note.group === 'instructions')
  if (!note) throw new Error('Instruction note is unavailable')
  const document = await readInstructionDocument(root, note.path, api)
  const parsed = parseMarkdown(document.content, instructionMetadata, note.path)
  return { note, parsed, draft: { revision: document.revision, settingsRevision: status.settingsRevision, path: note.path, body: parsed.body, includes: parsed.metadata.includes, hash: contentHash(document.content) } }
}

export function configurationHandlers(root: string, api: ConfigurationApi = backendApi()): Record<string, (input: unknown) => Promise<unknown>> {
  const conversationDocument = async (id: string) => {
    const thread = await readChat(root, id, api)
    if (!thread?.instructionsPath) throw new Error('Conversation configuration is unavailable')
    const document = await readInstructionDocument(root, thread.instructionsPath, api)
    return { document, path: thread.instructionsPath, note: parseMarkdown(document.content, conversationSettingsSchema, thread.instructionsPath) }
  }
  const projectDocument = async (id: string) => {
    const project = await api.data.dataset('projects').get({ id })
    if (!project || project.deleting) throw new Error('Project is unavailable')
    const file = configurationPath(root, projectConfigurationNote(id)), document = await readDocument(file, api)
    const note = parseMarkdown(document.content, z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(256), includes: includesSchema }).strict(), file)
    if (note.metadata.id !== id) throw new Error('Project identity cannot change')
    return { file, document, note }
  }
  return {
    'configuration.settings': () => readSettingsDocument(root, api),
    'configuration.set': async input => { const patch = z.object({ key: z.string().max(128), value: z.unknown(), expectedRevision: z.number().int().nonnegative() }).strict().parse(input); await saveSettings(root, { [patch.key]: patch.value }, patch.expectedRevision, api); return readSettingsDocument(root, api) },
    'configuration.status': input => configurationStatus(root, input ?? {}, api),
    'configuration.note': async input => (await configurationNote(root, noteTarget.parse(input), api)).draft,
    'configuration.note.set': async input => {
      const value = noteTarget.extend({ body: z.string().max(65536), includes: includesSchema, expectedRevision: z.number().int().nonnegative() }).strict().parse(input)
      const selection = noteTarget.parse({ scope: value.scope, id: value.id, noteId: value.noteId })
      const initial = await configurationNote(root, selection, api)
      const lock = value.scope === 'channel' ? configurationPath(root, 'config/channels.md') : `${root}/${initial.note.path}`
      return runExclusive(lock, async () => {
        const note = initial.note, current = await readInstructionDocument(root, note.path, api)
        const parsed = parseMarkdown(current.content, instructionMetadata, note.path)
        if (current.revision !== value.expectedRevision) throw Object.assign(new Error('Instructions changed. Reload them before saving your edits.'), { code: 'REVISION_CONFLICT', outcome: 'not-applied', currentRevision: current.revision })
        const source = formatMarkdown({ ...parsed.metadata, includes: value.includes }, value.body)
        await compileInstructionRoots([note.path], path => path === note.path ? Promise.resolve(source) : readInstructionNote(root, path, api))
        const saved = await writeInstructionDocument(root, note.path, source, value.expectedRevision, api)
        api.rpc.emit('configuration.changed', { path: note.path })
        return { revision: saved.revision, settingsRevision: initial.draft.settingsRevision, path: note.path, body: value.body.trim(), includes: value.includes, hash: contentHash(source) } satisfies ConfigurationDraft
      })
    },
    'configuration.link': async input => {
      const value = z.object({ key: z.enum(['global', 'vault', 'external', 'tools', 'voice', 'plan', 'telegram', 'whatsapp', 'chatNaming']), path: z.string().max(4096), expectedRevision: z.number().int().nonnegative() }).strict().parse(input)
      await saveInstructionLink(root, value.key, value.path, value.expectedRevision, api)
      return configurationStatus(root, {}, api)
    },
    'configuration.validateNote': async input => { const value = z.object({ path: z.string().max(4096) }).strict().parse(input); await readInstructionNote(root, value.path, api); return { path: noteReference(value.path) } },
    'configuration.speech': () => readSpeechDocument(root, api),
    'configuration.speech.set': async input => {
      const value = z.object({ expectedRevision: z.number().int().nonnegative(), patch: speechSchema.partial().strict() }).strict().parse(input)
      await saveSpeechSettings(root, value.patch, value.expectedRevision, api)
      return readSpeechDocument(root, api)
    },
    'configuration.conversation': async input => {
      const value = z.object({ id: z.string().min(1).max(256) }).strict().parse(input), current = await conversationDocument(value.id)
      return { revision: current.document.revision, values: current.note.metadata }
    },
    'configuration.conversation.set': async input => {
      const value = z.object({ id: z.string().min(1).max(256), expectedRevision: z.number().int().nonnegative(), patch: conversationSettingsSchema.partial().strict() }).strict().parse(input)
      const current = await conversationDocument(value.id), values = conversationSettingsSchema.parse({ ...current.note.metadata, ...value.patch })
      const saved = await writeInstructionDocument(root, current.path, formatMarkdown(values, current.note.body), value.expectedRevision, api)
      api.rpc.emit('configuration.changed', { path: current.path })
      return { revision: saved.revision, values }
    },
    'configuration.project': async input => {
      const value = z.object({ id: z.string().uuid() }).strict().parse(input), current = await projectDocument(value.id)
      return { revision: current.document.revision, values: { name: current.note.metadata.name, instructions: current.note.body, includes: current.note.metadata.includes } }
    },
    'configuration.project.set': async input => {
      const value = z.object({ id: z.string().uuid(), expectedRevision: z.number().int().nonnegative(), patch: z.object({ name: z.string().trim().min(1).max(256).optional(), instructions: z.string().max(65536).optional(), includes: includesSchema.optional() }).strict() }).strict().parse(input)
      const current = await projectDocument(value.id), values = { name: value.patch.name ?? current.note.metadata.name, instructions: value.patch.instructions ?? current.note.body, includes: value.patch.includes ?? current.note.metadata.includes }
      const saved = await writeDocument(current.file, formatMarkdown({ id: value.id, name: values.name, includes: values.includes }, values.instructions), value.expectedRevision, api)
      api.rpc.emit('configuration.changed', { path: relativeAssistantNote(projectConfigurationNote(value.id)) })
      return { revision: saved.revision, values }
    },
  }
}

export { compileInstructions } from './instructions'
export { effectiveSettings } from './settings'
