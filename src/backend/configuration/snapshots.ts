import type { z } from 'zod'
import { configurationPath, contentHash, parseMarkdown, readOptional, writeSnapshot } from './markdown'
import { clearConfigurationError, reportConfigurationError } from './settings'

export async function validatedNote<S extends z.ZodTypeAny>(root: string, file: string, source: string, schema: S, validate?: (metadata: z.output<S>, body: string) => void) {
  const cache = configurationPath(root, `runtime/configuration/notes/${contentHash(file)}.json`)
  try {
    const note = parseMarkdown(source, schema, file)
    validate?.(note.metadata, note.body)
    await writeSnapshot(cache, { source })
    clearConfigurationError(file)
    return { ...note, source, retained: false }
  } catch (error) {
    let previous: { metadata: z.output<S>; body: string; source: string; retained: boolean } | undefined
    try {
      const text = await readOptional(cache), parsed = text ? JSON.parse(text) : undefined
      if (typeof parsed?.source === 'string') {
        const note = parseMarkdown(parsed.source, schema, file)
        validate?.(note.metadata, note.body)
        previous = { ...note, source: parsed.source, retained: true }
      }
    } catch { /* A malformed derived snapshot cannot activate. */ }
    reportConfigurationError(file, error, Boolean(previous))
    if (previous) return previous
    throw error
  }
}
