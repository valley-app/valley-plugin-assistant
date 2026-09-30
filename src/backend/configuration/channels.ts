import { z } from 'zod'
import { backendApi } from '../runtime'
import { atomicWriteFile } from '../filesystem'
import { runExclusive, queuedWriteJson } from '../fileQueue'
import { writeSnapshot, configurationPath, formatMarkdown, parseMarkdown, readOptional, relativeAssistantNote } from './markdown'
import { commandSchema, includesSchema, routingSchema } from './schemas'
import { clearConfigurationError, reportConfigurationError } from './settings'

const channelSchema = z.object({
  type: z.string().min(1).max(64), name: z.string().min(1).max(256), allowFrom: z.array(z.string().max(256)).max(1000), enabled: z.boolean(),
  defaultProfile: z.string().max(256).optional(), instructionsPath: z.string().max(4096).optional(),
  defaultHarness: z.enum(['valley', 'deepseek', 'openai-modified']).optional(), defaultRouting: routingSchema.optional(),
  commands: z.array(commandSchema).max(100).optional(), attachmentParser: z.string().max(512).optional(),
  phoneNumberId: z.string().max(256).optional(), graphVersion: z.string().regex(/^v\d+\.\d+$/).optional(),
  webhookPort: z.number().int().min(1).max(65535).optional(), publicCallbackUrl: z.string().url().optional(),
  includes: includesSchema,
}).strict()
const indexSchema = z.object({ connections: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)).max(100) }).strict()
type StoredChannel = z.infer<typeof channelSchema> & { guard?: unknown }

export function channelConfigurationNote(id: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new Error('Invalid channel configuration identity')
  return `config/channels/${id}.md`
}

export async function writeChannelConfigurations<T extends Record<string, object>>(root: string, record: T): Promise<void> {
  const indexFile = configurationPath(root, 'config/channels.md')
  await runExclusive(indexFile, async () => {
    const ids = Object.keys(record)
    indexSchema.parse({ connections: ids })
    const policies: Record<string, unknown> = {}
    const notes: Array<{ file: string; content: string }> = []
    for (const [id, value] of Object.entries(record)) {
      const { guard, ...configuration } = value as StoredChannel
      const relative = channelConfigurationNote(id), file = configurationPath(root, relative)
      const existing = await readOptional(file)
      const prior = existing ? parseMarkdown(existing, channelSchema, file) : null
      const metadata = channelSchema.parse({ ...configuration, includes: prior?.metadata.includes ?? [] })
      const body = prior?.body ?? `# ${metadata.name}\n\nConnection configuration and additional instructions. Credentials and Guard policy are managed by core services. Edit includes to link additional instruction notes.`
      notes.push({ file, content: formatMarkdown(metadata, body) })
      if (guard !== undefined) policies[id] = guard
    }
    for (const note of notes) await atomicWriteFile(note.file, note.content)
    await queuedWriteJson(configurationPath(root, 'runtime/configuration/channel-policies.json'), policies)
    const existingIndex = await readOptional(indexFile)
    const body = existingIndex ? parseMarkdown(existingIndex, indexSchema, indexFile).body : '# Connections\n\nEach connection is configured in its linked Markdown note. Removing an ID here disables it; retained notes preserve recovery data.'
    await atomicWriteFile(indexFile, formatMarkdown({ connections: ids }, body))
  })
  backendApi().rpc.emit('configuration.changed', { path: relativeAssistantNote('config/channels.md') })
}

export async function readChannelConfigurations<T extends Record<string, object>>(root: string, legacy: T): Promise<T> {
  const indexFile = configurationPath(root, 'config/channels.md')
  if (await readOptional(indexFile) === null) await writeChannelConfigurations(root, legacy)
  const cacheFile = configurationPath(root, 'runtime/configuration/channels.last-valid.json')
  const policySource = await readOptional(configurationPath(root, 'runtime/configuration/channel-policies.json'))
  const policies = policySource ? z.record(z.unknown()).parse(JSON.parse(policySource)) : {}
  try {
    const index = parseMarkdown((await readOptional(indexFile))!, indexSchema, indexFile).metadata
    const result: Record<string, object> = {}
    for (const id of index.connections) {
      const relative = channelConfigurationNote(id), file = configurationPath(root, relative), source = await readOptional(file)
      if (!source) throw new Error(`${relative}: connection note is missing`)
      const { includes: _includes, ...configuration } = parseMarkdown(source, channelSchema, file).metadata
      result[id] = { ...configuration, ...(policies[id] === undefined ? {} : { guard: policies[id] }) }
    }
    await writeSnapshot(cacheFile, result)
    clearConfigurationError(indexFile)
    return result as T
  } catch (error) {
    const source = await readOptional(cacheFile)
    let retained: T | undefined
    if (source) {
      try {
        const record = z.record(z.object({}).passthrough()).parse(JSON.parse(source))
        for (const [id, value] of Object.entries(record)) {
          channelConfigurationNote(id)
          const { guard: _guard, ...configuration } = value
          channelSchema.parse(configuration)
          record[id] = { ...configuration, ...(policies[id] === undefined ? {} : { guard: policies[id] }) }
        }
        retained = record as T
      } catch { /* invalid caches are never authoritative */ }
    }
    reportConfigurationError(indexFile, error, Boolean(retained))
    if (retained) return retained
    throw error
  }
}
