import { z } from 'zod'
import { ensureScaffold, readCommands } from '../store'
import { readChat } from '../threads'
import { projectFor } from '../projects'
import { channelConfigurationNote } from './channels'
import { projectConfigurationNote } from './conversations'
import { noteReference, readInstructionNote, relativeAssistantNote } from './markdown'
import { configurationDiagnostics, effectiveSettings, saveInstructionLink, saveSettings } from './settings'
import { readSpeechSettings, saveSpeechSettings } from './speech'

export interface ConfigurationNote { id: string; group: 'instructions' | 'files'; path: string; key?: string }
export interface ConfigurationStatus { notes: ConfigurationNote[]; diagnostics: ReturnType<typeof configurationDiagnostics> }
const target = z.object({ scope: z.enum(['settings', 'chat', 'channel', 'conversation', 'project']).default('settings'), id: z.string().max(256).optional() }).strict()

export async function configurationStatus(root: string, input: unknown = {}): Promise<ConfigurationStatus> {
  const request = target.parse(input)
  await ensureScaffold(root)
  const settings = await effectiveSettings(root)
  let notes: ConfigurationNote[] = []
  if (request.scope === 'conversation') {
    const thread = request.id ? await readChat(root, request.id) : null
    if (!thread?.instructionsPath) throw new Error('Conversation configuration is unavailable')
    notes = [{ id: 'conversation', group: 'instructions', path: thread.instructionsPath }]
  } else if (request.scope === 'project') {
    if (!request.id) throw new Error('Project identity is required')
    await projectFor(request.id)
    notes = [{ id: 'project', group: 'instructions', path: relativeAssistantNote(projectConfigurationNote(request.id)) }]
  } else if (request.scope === 'channel') {
    if (!request.id) throw new Error('Connection identity is required')
    notes = [{ id: 'channel', group: 'instructions', path: relativeAssistantNote(channelConfigurationNote(request.id)) }]
  } else {
    await Promise.all([readSpeechSettings(root), readCommands(root)])
    notes = request.scope === 'chat' ? [
      { id: 'defaults', group: 'files', path: relativeAssistantNote('settings.md') },
      { id: 'chatNaming', group: 'instructions', key: 'chatNaming', path: noteReference(settings.instructions.chatNaming) },
    ] : [
      { id: 'home', group: 'files', path: relativeAssistantNote('README.md') },
      { id: 'commands', group: 'files', path: relativeAssistantNote('commands.md') },
      ...Object.entries(settings.instructions).filter(([key]) => key !== 'chatNaming').map(([key, value]) => ({ id: key, group: 'instructions' as const, key, path: noteReference(value) })),
    ]
  }
  return { notes, diagnostics: configurationDiagnostics() }
}

export function configurationHandlers(root: string): Record<string, (input: unknown) => Promise<unknown>> {
  return {
    'configuration.settings': () => effectiveSettings(root),
    'configuration.set': async input => { const patch = z.object({ key: z.string().max(128), value: z.unknown() }).strict().parse(input); return saveSettings(root, { [patch.key]: patch.value }) },
    'configuration.status': input => configurationStatus(root, input ?? {}),
    'configuration.link': async input => {
      const value = z.object({ key: z.enum(['global', 'vault', 'external', 'tools', 'voice', 'plan', 'telegram', 'whatsapp', 'chatNaming']), path: z.string().max(4096) }).strict().parse(input)
      await saveInstructionLink(root, value.key, value.path)
      return configurationStatus(root)
    },
    'configuration.validateNote': async input => { const value = z.object({ path: z.string().max(4096) }).strict().parse(input); await readInstructionNote(root, value.path); return { path: noteReference(value.path) } },
    'configuration.speech': () => readSpeechSettings(root),
    'configuration.speech.set': input => saveSpeechSettings(root, z.record(z.unknown()).parse(input)),
  }
}

export { compileInstructions } from './instructions'
export { effectiveSettings } from './settings'
