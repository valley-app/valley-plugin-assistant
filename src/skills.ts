/**
 * Pure helpers for the **Toolbox** — capabilities authored as vault files under
 * `.valley/plugins/data/assistant/toolbox/<Skill>/`. A skill is a folder with:
 *   - `skill.md`   front-matter (name/description/when) + markdown instructions.
 *   - `skill.json` (optional) a runnable declaration: which allow-listed runnable
 *                  to execute and which input keys map onto it.
 * The agent tools (`list_skills`/`read_skill`/`run_skill` in agent/tools.ts) are the
 * only callers; Assistant validates runnables in its backend and executes them through
 * the generic approved native-tool capability. Keeping this dependency-free and
 * pure makes it unit-testable without the running store.
 */

export const TOOLBOX_DIR = '.valley/plugins/data/assistant/toolbox'

export interface SkillMeta {
  /** Folder name (the id used by read_skill/run_skill). */
  id: string
  /** Display name from front-matter, falls back to the folder id. */
  name: string
  /** One-line summary surfaced by list_skills. */
  description: string
  /** Optional "when to use" hint. */
  when?: string
}

export interface SkillRun {
  /** A runnable name the Assistant package supports (e.g. "markitdown"). */
  runnable: string
  /** Which input keys are passed as named args to the runnable, in order. */
  argsFrom: string[]
}

/**
 * Parse a `---`-fenced front-matter block (simple `key: value` lines) plus the
 * markdown body. Tolerant: a file with no front-matter yields empty meta + the
 * whole text as the body.
 */
export function parseFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  const m = md.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { meta: {}, body: md }
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (kv) meta[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return { meta, body: m[2] }
}

/** Build a `SkillMeta` from a folder id and its `skill.md` text. */
export function skillMetaFrom(id: string, skillMd: string): SkillMeta {
  const { meta } = parseFrontmatter(skillMd)
  return {
    id,
    name: meta.name || id,
    description: meta.description || '',
    ...(meta.when ? { when: meta.when } : {})
  }
}

/** Parse a `skill.json` into a `SkillRun`, or null when absent/malformed/runless. */
export function parseSkillManifest(json: string): SkillRun | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  const run = (parsed as { run?: unknown })?.run
  if (!run || typeof run !== 'object') return null
  const r = run as { runnable?: unknown; argsFrom?: unknown }
  if (typeof r.runnable !== 'string' || !r.runnable.trim()) return null
  const argsFrom = Array.isArray(r.argsFrom) ? r.argsFrom.filter((x): x is string => typeof x === 'string') : []
  return { runnable: r.runnable.trim(), argsFrom }
}
