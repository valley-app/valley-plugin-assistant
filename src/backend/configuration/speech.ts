import { atomicWriteFile } from '../filesystem'
import { queuedWriteJson, runExclusive } from '../fileQueue'
import { backendApi } from '../runtime'
import { writeSnapshot, configurationPath, formatMarkdown, parseMarkdown, readOptional } from './markdown'
import { speechSchema } from './schemas'
import { clearConfigurationError, reportConfigurationError } from './settings'

export async function readSpeechSettings(root: string) {
  const file = configurationPath(root, 'speech.md'), cache = configurationPath(root, 'runtime/configuration/speech.last-valid.json')
  await runExclusive(file, async () => {
    if (await readOptional(file) === null) await atomicWriteFile(file, formatMarkdown(speechSchema.parse({}), '# Speech settings\n\nChoose a provider and its available voice ID. Models may be omitted to use the provider default. Voice IDs are account-specific; no voice is invented. Credentials stay in core. Cross-provider fallback is disabled unless explicitly selected.'))
  })
  try {
    const settings = parseMarkdown((await readOptional(file))!, speechSchema, file).metadata
    await writeSnapshot(cache, settings)
    clearConfigurationError(file)
    return settings
  } catch (error) {
    const source = await readOptional(cache)
    let previous: ReturnType<typeof speechSchema.parse> | undefined
    try { if (source) previous = speechSchema.parse(JSON.parse(source)) } catch { /* ignore invalid derived cache */ }
    reportConfigurationError(file, error, Boolean(previous))
    if (previous) return previous
    throw error
  }
}

export async function saveSpeechSettings(root: string, patch: Record<string, unknown>) {
  await readSpeechSettings(root)
  const file = configurationPath(root, 'speech.md')
  await runExclusive(file, async () => {
    const note = parseMarkdown((await readOptional(file))!, speechSchema, file)
    await atomicWriteFile(file, formatMarkdown(speechSchema.parse({ ...note.metadata, ...patch }), note.body))
  })
  const settings = await readSpeechSettings(root)
  backendApi().rpc.emit('configuration.changed', { path: file })
  return settings
}
