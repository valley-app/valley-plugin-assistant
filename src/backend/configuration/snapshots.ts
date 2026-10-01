import type { z } from 'zod'
import type { ConfigurationApi } from './documents'
import { backendApi } from '../runtime'
import { configurationPath, contentHash, parseMarkdown, readOptional, writeSnapshot } from './markdown'
import { clearConfigurationError, reportConfigurationError } from './settings'

export async function validatedNote<S extends z.ZodTypeAny>(root: string, file: string, source: string, schema: S, validate?: (metadata: z.output<S>, body: string) => void, api: ConfigurationApi = backendApi()) {
  const cache = configurationPath(root, `runtime/configuration/notes/${contentHash(file)}.json`)
  try {
    const note = parseMarkdown(source, schema, file)
    validate?.(note.metadata, note.body)
    await writeSnapshot(cache, { source }, api)
    clearConfigurationError(file)
    return { ...note, source, retained: false }
  } catch (error) {
    let previous: { metadata: z.output<S>; body: string; source: string; retained: boolean } | undefined
    try {
      const text = await readOptional(cache, api), parsed = text ? JSON.parse(text) : undefined
      if (typeof parsed?.source === 'string') {
        const note = parseMarkdown(parsed.source, schema, file)
        validate?.(note.metadata, note.body)
        previous = { ...note, source: parsed.source, retained: true }
      }
    } catch { /* A malformed derived snapshot cannot activate. */ }
    reportConfigurationError(file, error, Boolean(previous), api)
    if (previous) return previous
    throw error
  }
}
