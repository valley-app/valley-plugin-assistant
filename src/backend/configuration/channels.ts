import { z } from 'zod'
import { backendApi } from '../runtime'
import { writeSnapshot, configurationPath, formatMarkdown, parseMarkdown, readOptional, relativeAssistantNote } from './markdown'
import { commandSchema, includesSchema, routingSchema } from './schemas'
import { clearConfigurationError, reportConfigurationError } from './settings'
import { readDocument, requireRevision, writeDocuments, type ConfigurationApi } from './documents'

export const channelSchema = z.object({
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

const observed = new WeakMap<object, Record<string, number>>()
const indexPath = 'config/channels.md'
const policiesPath = 'runtime/configuration/channel-policies.json'
export function channelConfigurationRevisions(record: object): Record<string, number> {
  const revisions = observed.get(record)
  if (!revisions) throw new Error('Read the channel configuration before changing it')
  return { ...revisions }
}

export async function writeChannelConfigurations<T extends Record<string, object>>(root: string, record: T, expectedRevisions: Record<string, number>, api?: ConfigurationApi): Promise<void> {
  const ids = Object.keys(record)
  indexSchema.parse({ connections: ids })
  const indexFile = configurationPath(root, indexPath), index = await readDocument(indexFile, api)
  const priorIds = index.content ? parseMarkdown(index.content, indexSchema, indexFile).metadata.connections : []
  const policies: Record<string, unknown> = {}
  const notes: Array<{ file: string; content: string; expectedRevision: number }> = []
  for (const [id, value] of Object.entries(record)) {
    const { guard, ...configuration } = value as StoredChannel
    const relative = channelConfigurationNote(id), file = configurationPath(root, relative)
    const existing = await readDocument(file, api)
    const expectedRevision = expectedRevisions?.[relative] ?? (!priorIds.includes(id) && !existing.content ? existing.revision : undefined)
    requireRevision(expectedRevision)
    const prior = existing.content ? parseMarkdown(existing.content, channelSchema, file) : null
    const metadata = channelSchema.parse({ ...configuration, includes: prior?.metadata.includes ?? [] })
    const body = prior?.body ?? `# ${metadata.name}\n\nConnection configuration and additional instructions. Credentials and Guard policy are managed by core services. Edit includes to link additional instruction notes.`
    notes.push({ file, content: formatMarkdown(metadata, body), expectedRevision })
    if (guard !== undefined) policies[id] = guard
  }
  for (const id of priorIds.filter(id => !(id in record))) {
    const relative = channelConfigurationNote(id), file = configurationPath(root, relative)
    const expectedRevision = expectedRevisions?.[relative]; requireRevision(expectedRevision)
    notes.push({ file, content: (await readDocument(file, api)).content, expectedRevision })
  }
  const indexRevision = expectedRevisions?.[indexPath], policyRevision = expectedRevisions?.[policiesPath]
  requireRevision(indexRevision); requireRevision(policyRevision)
  const body = index.content ? parseMarkdown(index.content, indexSchema, indexFile).body : '# Connections\n\nEach connection is configured in its linked Markdown note. Removing an ID here disables it; retained notes preserve recovery data.'
  notes.push({ file: configurationPath(root, policiesPath), content: JSON.stringify(policies, null, 2) + '\n', expectedRevision: policyRevision }, { file: indexFile, content: formatMarkdown({ connections: ids }, body), expectedRevision: indexRevision })
  await writeDocuments(notes, api)
  ;(api ?? backendApi()).rpc.emit('configuration.changed', { path: relativeAssistantNote(indexPath) })
}

export async function readChannelConfigurations<T extends Record<string, object>>(root: string, legacy: T, api?: ConfigurationApi): Promise<T> {
  const indexFile = configurationPath(root, indexPath)
  let indexDocument = await readDocument(indexFile, api)
  let policyDocument = await readDocument(configurationPath(root, policiesPath), api)
  if (api && !indexDocument.content) { const result = {} as T; observed.set(result, { [indexPath]: indexDocument.revision, [policiesPath]: policyDocument.revision }); return result }
  if (!indexDocument.content) {
    const revisions: Record<string, number> = { [indexPath]: indexDocument.revision, [policiesPath]: policyDocument.revision }
    for (const id of Object.keys(legacy)) { const relative = channelConfigurationNote(id); revisions[relative] = (await readDocument(configurationPath(root, relative), api)).revision }
    await writeChannelConfigurations(root, legacy, revisions, api)
    indexDocument = await readDocument(indexFile, api); policyDocument = await readDocument(configurationPath(root, policiesPath), api)
  }
  const revisions: Record<string, number> = { [indexPath]: indexDocument.revision, [policiesPath]: policyDocument.revision }
  const cacheFile = configurationPath(root, 'runtime/configuration/channels.last-valid.json')
  const policySource = policyDocument.content
  const policies = policySource ? z.record(z.unknown()).parse(JSON.parse(policySource)) : {}
  try {
    const index = parseMarkdown(indexDocument.content, indexSchema, indexFile).metadata
    const result: Record<string, object> = {}
    for (const id of index.connections) {
      const relative = channelConfigurationNote(id), file = configurationPath(root, relative), document = await readDocument(file, api), source = document.content
      revisions[relative] = document.revision
      if (!source) throw new Error(`${relative}: connection note is missing`)
      const { includes: _includes, ...configuration } = parseMarkdown(source, channelSchema, file).metadata
      result[id] = { ...configuration, ...(policies[id] === undefined ? {} : { guard: policies[id] }) }
    }
    if (!api) await writeSnapshot(cacheFile, result)
    clearConfigurationError(indexFile)
    observed.set(result, revisions)
    return result as T
  } catch (error) {
    if (api) throw error
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
    if (retained) { observed.set(retained, revisions); return retained }
    throw error
  }
}
