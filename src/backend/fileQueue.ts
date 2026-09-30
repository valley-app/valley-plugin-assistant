import * as fs from './filesystem'
import path from 'path-browserify'
import { atomicWriteFile, queueFileWrite } from './filesystem'

/**
 * Main-process per-file write serialization for the guard- and Chorus-owned
 * assistant files — `guards.json`, the per-chat `settings.json`, `memory.jsonl`,
 * and `thread.jsonl` (C16). Concurrent writes can otherwise race with sync
 * clients, hot reloads, settings saves, and multiple assistant turns: a full
 * rewrite that overlaps an append corrupts the file or drops records.
 *
 * Every op is keyed by the **absolute file path** and queued behind the previous
 * op for that path, so operations on one file run strictly in order while
 * different files stay concurrent (mirrors the `.jsonl` mutation queue in
 * `vault/jsonl.ts`). Full rewrites go through {@link atomicWriteFile}
 * (temp-file + atomic `rename`), so a half-failed rewrite leaves the previous
 * file intact and readable. JSONL appends are written in enqueue order.
 *
 * The renderer must never write these files directly — it routes through the
 * `ai` driver, which calls these helpers.
 */

export function runExclusive<T>(file: string, operation: () => Promise<T>): Promise<T> {
  return queueFileWrite(file, operation)
}

/** Atomic full rewrite of a text file, serialized by path. Creates parent dirs. */
export function queuedWrite(file: string, content: string): Promise<void> {
  return runExclusive(file, () => atomicWriteFile(file, content))
}

/**
 * Atomic full rewrite of a JSON file, serialized by path. The value is
 * serialized **inside** the critical section, so a non-serializable value
 * (e.g. a circular reference) throws before any byte is written and the
 * previous file is left intact (the rejection still propagates to the caller).
 */
export function queuedWriteJson(file: string, value: unknown): Promise<void> {
  return runExclusive(file, async () => {
    const content = JSON.stringify(value, null, 2)
    await atomicWriteFile(file, content)
  })
}

/**
 * Append finalized JSONL records to `file` in enqueue order, serialized by path.
 * One JSON object per line, trailing newline. Creates the file/dir on first
 * write. A no-op for an empty list (so callers can append unconditionally).
 */
export function queuedAppendJsonl(file: string, records: readonly unknown[]): Promise<void> {
  if (records.length === 0) return Promise.resolve()
  return runExclusive(file, async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
    await fs.appendFile(file, text, 'utf8')
  })
}
