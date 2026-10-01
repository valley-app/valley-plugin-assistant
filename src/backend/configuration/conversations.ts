import { z } from 'zod'
import type { AiChatThread, AssistantProject } from '../../types'
import { runExclusive } from '../fileQueue'
import { conversationSettingsSchema, includesSchema } from './schemas'
import { configurationPath, contentHash, formatMarkdown, parseMarkdown } from './markdown'

import { validatedNote } from './snapshots'
import { backendApi } from '../runtime'
import { readDocument, requireRevision, writeDocument, type ConfigurationApi } from './documents'

const keys = ['model', 'reasoningEffort', 'profileId', 'attachmentParser', 'commands'] as const
const selection = (thread: Partial<AiChatThread>) => Object.fromEntries(keys.filter(key => thread[key] !== undefined && !(key === 'model' && thread[key] === null)).map(key => [key, thread[key]]))
export async function conversationConfiguration(root: string, directory: string, legacy: Partial<AiChatThread>, write?: Partial<AiChatThread>, expectedRevision?: number, api: ConfigurationApi = backendApi()) {
  const file = `${directory}/settings.md`
  return runExclusive(file, async () => {
    let document = await readDocument(file, api), source = document.content
    const creating = !source
    if (!source) {
      source = formatMarkdown(conversationSettingsSchema.parse(selection(write ?? legacy)), '# Conversation instructions\n\nAdd instructions for this conversation here, or use includes to link a Markdown note. Model, personality, parser and custom commands are configured in frontmatter. Chat identity, history and approval state are managed separately.')
      if (!write) {
        const note = parseMarkdown(source, conversationSettingsSchema, file)
        const settings = Object.fromEntries(keys.map(key => [key, note.metadata[key]])) as Pick<AiChatThread, typeof keys[number]>
        return { settings, revision: document.revision, hash: contentHash(source), instructionsPath: file.slice(root.length + 1), body: note.body }
      }
      if (JSON.stringify(selection(write)) !== JSON.stringify(selection(legacy))) requireRevision(expectedRevision)
      if (expectedRevision !== undefined && expectedRevision !== document.revision) throw Object.assign(new Error('Conversation settings changed; reload the Markdown note before updating them'), { code: 'REVISION_CONFLICT', outcome: 'not-applied', currentRevision: document.revision })
      await writeDocument(file, source, document.revision, api)
      document = await readDocument(file, api)
    }
    let note = await validatedNote(root, file, source, conversationSettingsSchema, undefined, api)
    if (!creating && write && JSON.stringify(selection(write)) !== JSON.stringify(selection(legacy))) {
      if (note.retained) throw new Error('Repair invalid conversation settings before updating them')
      requireRevision(expectedRevision)
      if (expectedRevision !== document.revision) throw Object.assign(new Error('Conversation settings changed; reload the Markdown note before updating them'), { code: 'REVISION_CONFLICT', outcome: 'not-applied', currentRevision: document.revision })
      note = { ...note, metadata: conversationSettingsSchema.parse({ ...selection(write), includes: note.metadata.includes }) }
      source = formatMarkdown(note.metadata, note.body)
      const saved = await writeDocument(file, source, expectedRevision, api)
      document = { content: source, revision: saved.revision }
      note = await validatedNote(root, file, source, conversationSettingsSchema, undefined, api)
    }
    const settings = Object.fromEntries(keys.map(key => [key, note.metadata[key]])) as Pick<AiChatThread, typeof keys[number]>
    return { settings, revision: document.revision, hash: contentHash(note.source), instructionsPath: file.slice(root.length + 1), body: note.body }
  })
}

const projectSchema = z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(256), includes: includesSchema }).strict()
export function projectConfigurationNote(id: string): string {
  z.string().uuid().parse(id)
  return `config/projects/${id}.md`
}
export async function projectConfiguration(root: string, project: AssistantProject, patch?: { name?: string; instructions?: string }, expectedRevision?: number, api: ConfigurationApi = backendApi()) {
  const file = configurationPath(root, projectConfigurationNote(project.id))
  return runExclusive(file, async () => {
    let document = await readDocument(file, api), source = document.content
    if (!source) {
      source = formatMarkdown({ id: project.id, name: project.name, includes: [] }, project.instructions)
      await writeDocument(file, source, document.revision, api)
      document = await readDocument(file, api)
    }
    const note = await validatedNote(root, file, source, projectSchema, metadata => { if (metadata.id !== project.id) throw new Error('Project note identity cannot change') }, api)
    if (patch) {
      requireRevision(expectedRevision)
      if (expectedRevision !== document.revision) throw Object.assign(new Error('Project configuration changed; reload before saving'), { code: 'REVISION_CONFLICT', outcome: 'not-applied', currentRevision: document.revision })
      if (note.retained) throw new Error('Repair invalid project settings before updating them')
      const metadata = projectSchema.parse({ ...note.metadata, ...(patch.name === undefined ? {} : { name: patch.name }) })
      const body = patch.instructions ?? note.body
      const saved = await writeDocument(file, formatMarkdown(metadata, body), expectedRevision, api)
      return { ...project, name: metadata.name, instructions: body, configurationRevision: saved.revision }
    }
    return { ...project, name: note.metadata.name, instructions: note.body, configurationRevision: document.revision }
  })
}
