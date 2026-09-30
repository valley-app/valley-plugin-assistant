import { z } from 'zod'
import type { AiChatThread, AssistantProject } from '../../types'
import { atomicWriteFile } from '../filesystem'
import { runExclusive } from '../fileQueue'
import { conversationSettingsSchema, includesSchema } from './schemas'
import { trySeed, configurationPath, contentHash, formatMarkdown, parseMarkdown, readOptional } from './markdown'

import { validatedNote } from './snapshots'

const keys = ['model', 'reasoningEffort', 'profileId', 'attachmentParser', 'commands'] as const
const selection = (thread: Partial<AiChatThread>) => Object.fromEntries(keys.filter(key => thread[key] !== undefined && !(key === 'model' && thread[key] === null)).map(key => [key, thread[key]]))
export async function conversationConfiguration(root: string, directory: string, legacy: Partial<AiChatThread>, write?: Partial<AiChatThread>, expectedHash?: string) {
  const file = `${directory}/settings.md`
  return runExclusive(file, async () => {
    let source = await readOptional(file)
    if (source === null) {
      source = formatMarkdown(conversationSettingsSchema.parse(selection(write ?? legacy)), '# Conversation instructions\n\nAdd instructions for this conversation here, or use includes to link a Markdown note. Model, personality, parser and custom commands are configured in frontmatter. Chat identity, history and approval state are managed separately.')
      if (write) await atomicWriteFile(file, source)
      else await trySeed(file, source)
    }
    let note = await validatedNote(root, file, source, conversationSettingsSchema)
    if (write && JSON.stringify(selection(write)) !== JSON.stringify(selection(legacy))) {
      if (note.retained) throw new Error('Repair invalid conversation settings before updating them')
      if (expectedHash && expectedHash !== contentHash(source)) throw new Error('Conversation settings changed; reload the Markdown note before updating them')
      note = { ...note, metadata: conversationSettingsSchema.parse({ ...selection(write), includes: note.metadata.includes }) }
      source = formatMarkdown(note.metadata, note.body)
      await atomicWriteFile(file, source)
      note = await validatedNote(root, file, source, conversationSettingsSchema)
    }
    const settings = Object.fromEntries(keys.map(key => [key, note.metadata[key]])) as Pick<AiChatThread, typeof keys[number]>
    return { settings, hash: contentHash(note.source), instructionsPath: file.slice(root.length + 1), body: note.body }
  })
}

const projectSchema = z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(256), includes: includesSchema }).strict()
export function projectConfigurationNote(id: string): string {
  z.string().uuid().parse(id)
  return `config/projects/${id}.md`
}
export async function projectConfiguration(root: string, project: AssistantProject, patch?: { name?: string; instructions?: string }) {
  const file = configurationPath(root, projectConfigurationNote(project.id))
  return runExclusive(file, async () => {
    let source = await readOptional(file)
    if (source === null) {
      source = formatMarkdown({ id: project.id, name: project.name, includes: [] }, project.instructions)
      if (patch) await atomicWriteFile(file, source)
      else await trySeed(file, source)
    }
    const note = await validatedNote(root, file, source, projectSchema, metadata => { if (metadata.id !== project.id) throw new Error('Project note identity cannot change') })
    if (patch) {
      if (note.retained) throw new Error('Repair invalid project settings before updating them')
      const metadata = projectSchema.parse({ ...note.metadata, ...(patch.name === undefined ? {} : { name: patch.name }) })
      const body = patch.instructions ?? note.body
      await atomicWriteFile(file, formatMarkdown(metadata, body))
      return { ...project, name: metadata.name, instructions: body }
    }
    return { ...project, name: note.metadata.name, instructions: note.body }
  })
}
