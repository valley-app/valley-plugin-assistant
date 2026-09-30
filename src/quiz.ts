import type { ValleyPluginApi } from './api'
import type { DataRecord } from '@valley/plugin-sdk/types'


/**
 * Pure quiz helpers for the Teacher-Assistant flow plus a tiny per-chat session
 * held by the Assistant's owner-scoped runtime. The agent tools in
 * `agent/tools.ts` are the only callers.
 *
 * A `listli.jsonl` record is one practice problem: a `problemText` (sometimes with
 * embedded `(A)…(D)` choices), one or more question `images`, and `notes` holding
 * the worked solution — often opening with "**X ist richtig.**" for multiple
 * choice and sometimes embedding a solution image as `![[name.jpg]]`.
 */

export interface QuizOption {
  letter: string
  text: string
}

export interface QuizProblem {
  id: string
  title: string
  problemText: string
  /** Embedded multiple-choice options, empty for free-text problems. */
  options: QuizOption[]
  /** The correct letter when derivable from the notes, else null. */
  answerLetter: string | null
  /** The worked solution / explanation (the `notes` field). */
  explanation: string
  /** Vault-relative question image paths. */
  images: string[]
  /** Solution-image embeds (`![[name]]`) referenced in the notes, by basename. */
  solutionImages: string[]
  difficulty?: number
  tags: string[]
  subject: string
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : [])

/**
 * Extract embedded "(A) … (B) …" multiple-choice options. The marker regex only
 * matches a single A–E in parentheses, so LaTeX like `(t)` or `\binom{(x)}` is
 * never mistaken for an option. Returns [] for a free-text problem.
 */
export function parseOptions(problemText: string): QuizOption[] {
  const re = /\(([A-E])\)/g
  const marks: { letter: string; start: number; end: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(problemText))) marks.push({ letter: m[1], start: m.index, end: re.lastIndex })
  if (marks.length < 2) return []
  return marks.map((mark, i) => ({
    letter: mark.letter,
    text: problemText.slice(mark.end, i + 1 < marks.length ? marks[i + 1].start : undefined).trim()
  }))
}

/**
 * The correct answer letter when the notes open with a bolded letter
 * ("**B ist richtig.**" / "**(A) …**" / "**A is correct**"). Null otherwise —
 * including every free-text solution that opens with a formula.
 */
export function parseAnswerLetter(notes: string): string | null {
  const m = notes.trim().match(/^\*\*\s*\(?([A-E])\)?[\s).,:]/)
  return m ? m[1].toUpperCase() : null
}

/** Solution-image embeds (`![[name.jpg]]` / `[[name.jpg]]`) referenced in the notes, by basename. */
export function parseSolutionImages(notes: string): string[] {
  const out: string[] = []
  const re = /!?\[\[([^\]]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(notes))) {
    const ref = m[1].split('#')[0].split('|')[0].trim()
    const base = ref.split('/').pop() ?? ref
    if (base && /\.(png|jpe?g|gif|webp|svg)$/i.test(base)) out.push(base)
  }
  return out
}

/** Normalize one tolerant-parsed jsonl record into a `QuizProblem`. */
export function toProblem(rec: DataRecord): QuizProblem {
  const problemText = str(rec.problemText)
  const explanation = str(rec.notes)
  return {
    id: str(rec.id) || str(rec.title),
    title: str(rec.title),
    problemText,
    options: parseOptions(problemText),
    answerLetter: parseAnswerLetter(explanation),
    explanation,
    images: strArr(rec.images),
    solutionImages: parseSolutionImages(explanation),
    difficulty: typeof rec.difficulty === 'number' ? rec.difficulty : undefined,
    tags: strArr(rec.tags),
    subject: str(rec.subject)
  }
}

/** Parse a `.jsonl` file's text into problems, skipping blank/malformed lines. */
export function parseProblems(jsonl: string): QuizProblem[] {
  const out: QuizProblem[] = []
  for (const line of jsonl.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(toProblem(JSON.parse(t) as DataRecord))
    } catch {
      // skip malformed line
    }
  }
  return out
}

/** A tappable answer choice: `value` is sent as the answer, `label` shown on the button. */
export interface QuizChoice {
  value: string
  label: string
}

/** A true/false ("wahr oder falsch") claim — its only answers are Wahr/Falsch. */
export function isTrueFalse(problemText: string): boolean {
  return /wahr\s+oder\s+falsch|wahr\s*\/\s*falsch|true\s+or\s+false/i.test(problemText)
}

/**
 * A multi-statement / multi-select question (the notes list several answers, e.g.
 * "**Wahr/Falsch: wahr, falsch, falsch.**"). Such a grid can't collapse to one tap —
 * the user must type, so it gets no answer buttons.
 */
export function isMultiAnswer(notes: string): boolean {
  return /wahr\s*\/\s*falsch\s*:/i.test(notes) || /(wahr|falsch)\s*,\s*(wahr|falsch)/i.test(notes)
}

/**
 * The answer buttons to offer — **only for a genuine choice question** (the user
 * clicks); everything else returns `[]` so the user must type the answer:
 *   - multi-statement / multi-select grid → `[]` (type)
 *   - single true/false claim → Wahr / Falsch
 *   - options parseable in the text → those letters
 *   - a single-choice whose options live only in the image (answer is one letter) → A–D
 *   - free input (no options, no letter) → `[]` (type)
 */
export function answerChoices(p: QuizProblem): QuizChoice[] {
  if (isMultiAnswer(p.explanation)) return []
  if (isTrueFalse(p.problemText)) {
    return [
      { value: 'Wahr', label: 'Wahr' },
      { value: 'Falsch', label: 'Falsch' }
    ]
  }
  if (p.options.length) return p.options.map((o) => ({ value: o.letter, label: o.letter }))
  if (p.answerLetter) return ['A', 'B', 'C', 'D'].map((l) => ({ value: l, label: l }))
  return []
}

export interface QuizFilter {
  multipleChoiceOnly?: boolean
  subject?: string
}

export function matchesFilter(p: QuizProblem, f: QuizFilter): boolean {
  if (f.multipleChoiceOnly && p.options.length === 0) return false
  if (f.subject && !p.subject.toLowerCase().includes(f.subject.toLowerCase())) return false
  return true
}

/** Pick a random problem not yet served that matches the filter; null when exhausted. */
export function pickProblem(
  problems: QuizProblem[],
  served: Set<string>,
  filter: QuizFilter,
  rand: () => number = Math.random
): QuizProblem | null {
  const pool = problems.filter((p) => !served.has(p.id) && matchesFilter(p, filter))
  if (!pool.length) return null
  return pool[Math.floor(rand() * pool.length)]
}

// ── Per-chat session (window-anchored) ────────────────────────────────────────

interface QuizSession {
  source: string
  served: Set<string>
}

function sessions(api: ValleyPluginApi): Map<string, QuizSession> {
  return api.runtime.getOrCreate('assistant.quizSessions', () => new Map())
}

export function sessionKey(channelId: string, chatRef: string): string {
  return `${channelId}:${chatRef}`
}

/**
 * The served-set for a chat's quiz on `source`. A new source or `reset` starts a
 * fresh set (so re-quizzing the same file or switching subjects works cleanly).
 */
export function sessionFor(api: ValleyPluginApi, key: string, source: string, reset = false): Set<string> {
  const map = sessions(api)
  const existing = map.get(key)
  if (!existing || existing.source !== source || reset) {
    const fresh: QuizSession = { source, served: new Set() }
    map.set(key, fresh)
    return fresh.served
  }
  return existing.served
}
