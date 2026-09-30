import type { AiToolCall } from '../types'

/** Parse JSON, returning `fallback` on any error (mirrors providers/tooling). */
function safeJson<T>(text: string, fallback: T): T {
  try {
    const v = JSON.parse(text)
    return (v ?? fallback) as T
  } catch {
    return fallback
  }
}

/**
 * Recover tool calls a model emitted as *text* instead of as a native structured
 * call. Weak/local models (llama3.2:3b and many Ollama chat templates) routinely
 * write the call into the assistant content — as a bare JSON object, a fenced
 * ```json block, or a `<tool_call>…</tool_call>` tag — rather than through the
 * provider's tool-call channel. The agent loop falls back to this when a turn
 * produced text but zero structured calls, so those models still *act* instead of
 * leaking raw JSON (or a "you can use these tools…" description) into the chat.
 *
 * Pure and provider-agnostic: every adapter (Ollama/OpenAI-compat/DeepSeek/Kimi)
 * benefits, and it is fully unit-testable. Only objects whose name resolves to a
 * real tool are recovered, so ordinary prose (even prose that mentions tool names)
 * never produces a false call.
 */

const TAG_RE = /<(tool_call|function_call|tool|function)>([\s\S]*?)<\/\1>/gi

/** A tolerant view of the many JSON shapes models use for a tool call. */
interface RawCall {
  name?: unknown
  tool?: unknown
  tool_name?: unknown
  function?: unknown
  arguments?: unknown
  parameters?: unknown
  args?: unknown
  input?: unknown
  params?: unknown
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The tool name from any of the shapes models produce (`name`/`tool`/`function`). */
function nameOf(raw: RawCall): string | null {
  const candidates = [raw.name, raw.tool, raw.tool_name, raw.function]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
    // `{"function": {"name": "x", "arguments": …}}` (OpenAI-style nested).
    if (isRecord(c) && typeof c.name === 'string' && c.name.trim()) return c.name.trim()
  }
  return null
}

/** The argument object from any of the shapes (`arguments`/`parameters`/`args`/`input`). */
function argsOf(raw: RawCall): Record<string, unknown> {
  // Nested `{"function":{"arguments":…}}` carries its own args.
  if (isRecord(raw.function)) {
    const inner = raw.function as RawCall
    const nested = inner.arguments ?? inner.parameters ?? inner.args ?? inner.input
    if (nested !== undefined) return normalizeArgs(nested)
  }
  const direct = raw.arguments ?? raw.parameters ?? raw.args ?? raw.input ?? raw.params
  return normalizeArgs(direct)
}

/** Args may arrive as an object or as a JSON string ("double-encoded"). */
function normalizeArgs(v: unknown): Record<string, unknown> {
  if (isRecord(v)) return v
  if (typeof v === 'string') {
    const parsed = safeJson<unknown>(v.trim(), null)
    if (isRecord(parsed)) return parsed
  }
  return {}
}

/**
 * Scan `text` for balanced `{…}` regions and return each one's span. A brace
 * counter (string-aware) handles nested objects that a regex cannot, so a call
 * whose arguments contain their own object/array is extracted whole.
 */
function jsonObjectSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = []
  let depth = 0
  let start = -1
  let inStr = false
  let quote = ''
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) inStr = false
      continue
    }
    if (ch === '"' || ch === "'") {
      inStr = true
      quote = ch
    } else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      if (depth > 0) {
        depth--
        if (depth === 0 && start >= 0) {
          spans.push({ start, end: i + 1 })
          start = -1
        }
      }
    }
  }
  return spans
}

export interface RecoveredToolCalls {
  calls: AiToolCall[]
  /** `text` with every recovered JSON/tag region removed (and tidied). */
  cleanedText: string
}

/**
 * Extract tool calls embedded as text. Returns the recovered calls and the text
 * with their source removed. When nothing recoverable is found, `calls` is empty
 * and `cleanedText` equals the trimmed input — the caller then treats the turn as
 * a normal final answer.
 */
export function recoverToolCalls(text: string, knownToolNames: Iterable<string>): RecoveredToolCalls {
  const known = new Set(knownToolNames)
  if (!text || !text.includes('{')) return { calls: [], cleanedText: text.trim() }

  const calls: AiToolCall[] = []
  const removals: { start: number; end: number }[] = []
  let seq = 0

  const consider = (jsonText: string, span: { start: number; end: number }): boolean => {
    const candidate = jsonText.trim()
    // Fall back to single→double quote normalization for a purely single-quoted
    // object (Python-dict style), but only when no double quotes are present so we
    // never corrupt apostrophes inside a real JSON string.
    const parsed =
      safeJson<unknown>(candidate, null) ??
      (candidate.includes("'") && !candidate.includes('"') ? safeJson<unknown>(candidate.replace(/'/g, '"'), null) : null)
    const records = Array.isArray(parsed) ? parsed : [parsed]
    let matched = false
    for (const rec of records) {
      if (!isRecord(rec)) continue
      const raw = rec as RawCall
      const name = nameOf(raw)
      if (!name || !known.has(name)) continue
      calls.push({ id: `recovered_${seq++}`, name, arguments: argsOf(raw) })
      matched = true
    }
    if (matched) removals.push(span)
    return matched
  }

  // 1) Explicit tag wrappers first — highest confidence.
  for (const m of text.matchAll(TAG_RE)) {
    const body = m[2]
    const idx = m.index ?? 0
    const inner = jsonObjectSpans(body)
    if (inner.length) {
      for (const s of inner) consider(body.slice(s.start, s.end), { start: idx, end: idx + m[0].length })
    } else {
      consider(body, { start: idx, end: idx + m[0].length })
    }
  }

  // 2) Bare / fenced JSON objects anywhere in the text.
  for (const span of jsonObjectSpans(text)) {
    // Skip a span already inside a tag region we consumed above.
    if (removals.some((r) => span.start >= r.start && span.end <= r.end)) continue
    consider(text.slice(span.start, span.end), span)
  }

  if (!calls.length) return { calls: [], cleanedText: text.trim() }

  // Build cleaned text by dropping every recovered region, then tidy leftover
  // fences and whitespace so the user sees prose (if any) without raw JSON.
  removals.sort((a, b) => a.start - b.start)
  let cleaned = ''
  let cursor = 0
  for (const r of removals) {
    if (r.start > cursor) cleaned += text.slice(cursor, r.start)
    cursor = Math.max(cursor, r.end)
  }
  cleaned += text.slice(cursor)
  cleaned = cleaned
    .replace(/```(?:json|tool|tool_call)?\s*```/gi, '')
    .replace(/```(?:json|tool|tool_call)?\s*$/gi, '')
    .replace(/^\s*```\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { calls, cleanedText: cleaned }
}
