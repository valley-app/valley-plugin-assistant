import type { CustomCommand } from '../types'

/**
 * Coerce arbitrary input into a clean `CustomCommand[]`: trims, lower-cases and
 * slug-validates each name (`[a-z0-9_-]`, no leading slash), drops entries with an
 * empty name or prompt and duplicate names, and caps the list. Shared by the
 * overall-commands store and the per-connection channel config so a malformed
 * file or renderer payload can never corrupt the dispatch path.
 */
export function normalizeCommands(input: unknown): CustomCommand[] {
  if (!Array.isArray(input)) return []
  const out: CustomCommand[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const name = String(r.name ?? '').trim().toLowerCase().replace(/^\/+/, '')
    const prompt = String(r.prompt ?? '')
    if (!/^[a-z0-9_-]+$/.test(name) || !prompt.trim() || seen.has(name)) continue
    seen.add(name)
    const cmd: CustomCommand = { name, prompt }
    const description = String(r.description ?? '').trim()
    if (description) cmd.description = description
    out.push(cmd)
    if (out.length >= 100) break
  }
  return out
}
