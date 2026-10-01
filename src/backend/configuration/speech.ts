import { runExclusive } from '../fileQueue'
import { backendApi } from '../runtime'
import { trySeed, writeSnapshot, configurationPath, formatMarkdown, parseMarkdown, readOptional } from './markdown'
import { speechSchema } from './schemas'
import { clearConfigurationError, reportConfigurationError } from './settings'
import { readDocument, requireRevision, writeDocument, type ConfigurationApi } from './documents'

async function ensureSpeechConfiguration(root: string, api: ConfigurationApi): Promise<void> {
  const file = configurationPath(root, 'speech.md')
  await runExclusive(file, async () => {
    if (await readOptional(file, api) === null) await trySeed(file, formatMarkdown(speechSchema.parse({}), '# Speech settings\n\nChoose a provider and its available voice ID. Models may be omitted to use the provider default. Voice IDs are account-specific; no voice is invented. Credentials stay in core. Cross-provider fallback is disabled unless explicitly selected.'), api)
  })
}

export async function readSpeechSettings(root: string, api: ConfigurationApi = backendApi()) {
  const file = configurationPath(root, 'speech.md'), cache = configurationPath(root, 'runtime/configuration/speech.last-valid.json')
  await ensureSpeechConfiguration(root, api)
  try {
    const settings = parseMarkdown((await readOptional(file, api))!, speechSchema, file).metadata
    await writeSnapshot(cache, settings, api)
    clearConfigurationError(file)
    return settings
  } catch (error) {
    const source = await readOptional(cache, api)
    let previous: ReturnType<typeof speechSchema.parse> | undefined
    try { if (source) previous = speechSchema.parse(JSON.parse(source)) } catch { /* ignore invalid derived cache */ }
    reportConfigurationError(file, error, Boolean(previous), api)
    if (previous) return previous
    throw error
  }
}

export async function readSpeechDocument(root: string, api: ConfigurationApi = backendApi()) {
  await ensureSpeechConfiguration(root, api)
  const file = configurationPath(root, 'speech.md'), document = await readDocument(file, api)
  return { revision: document.revision, values: speechSchema.parse(parseMarkdown(document.content, speechSchema, file).metadata) }
}

export async function saveSpeechSettings(root: string, patch: Record<string, unknown>, expectedRevision: number, api: ConfigurationApi = backendApi()) {
  requireRevision(expectedRevision)
  await ensureSpeechConfiguration(root, api)
  const file = configurationPath(root, 'speech.md')
  const settings = await runExclusive(file, async () => {
    const document = await readDocument(file, api)
    if (document.revision !== expectedRevision) throw Object.assign(new Error('Speech settings changed; reload before saving'), { code: 'REVISION_CONFLICT', outcome: 'not-applied', currentRevision: document.revision })
    const note = parseMarkdown(document.content, speechSchema, file)
    const next = speechSchema.parse({ ...note.metadata, ...patch })
    await writeDocument(file, formatMarkdown(next, note.body), expectedRevision, api)
    return next
  })
  api.rpc.emit('configuration.changed', { path: file })
  return settings
}
