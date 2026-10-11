import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import * as fs from '../filesystem'
import { join } from 'path-browserify'
import { ASSISTANT_HARNESS_CACHE_DIR } from './paths'
import type { HarnessCompletion } from '../../harnessTypes'
import { atomicWriteFile } from '../filesystem'
import { z } from 'zod'

interface CacheEntry {
  createdAt: number
  value: HarnessCompletion
}

export function harnessCacheKey(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(stableJson(value))))
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function dir(root: string, harnessId: string): string {
  return join(root, ASSISTANT_HARNESS_CACHE_DIR, harnessId)
}

export async function readHarnessCache(
  root: string,
  harnessId: string,
  key: string,
  maxAgeDays: number
): Promise<HarnessCompletion | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(join(dir(root, harnessId), `${key}.json`), 'utf8')) as CacheEntry
    if (!parsed?.createdAt || Date.now() - parsed.createdAt > maxAgeDays * 86_400_000) return null
    return { ...parsed.value, cached: true }
  } catch {
    return null
  }
}

export async function writeHarnessCache(
  root: string,
  harnessId: string,
  key: string,
  value: HarnessCompletion,
  maxSizeMb: number
): Promise<void> {
  const folder = dir(root, harnessId)
  await atomicWriteFile(join(folder, `${key}.json`), JSON.stringify({ createdAt: Date.now(), value } satisfies CacheEntry))
  const entries = await Promise.all((await fs.readdir(folder, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map(async (entry) => {
      const path = join(folder, entry.name)
      const stat = await fs.stat(path)
      return { path, size: stat.size, mtimeMs: stat.mtimeMs }
    }))
  let total = entries.reduce((sum, entry) => sum + entry.size, 0)
  const limit = maxSizeMb * 1024 * 1024
  for (const entry of entries.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= limit) break
    await fs.rm(entry.path, { force: true })
    total -= entry.size
  }
}

export async function clearHarnessCache(root: string, harnessId: string): Promise<void> {
  await fs.rm(dir(root, harnessId), { recursive: true, force: true })
}

// clear-cache revert: the exact cache files of one harness, rewritten only while the folder is unchanged since the clear.
const CACHE_SNAPSHOT_BYTES = 512 * 1024
export const harnessCacheSnapshotSchema = z.object({ harnessId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), entries: z.array(z.object({ name: z.string().regex(/^[^/\\]{1,255}\.json$/), base64: z.string().max(CACHE_SNAPSHOT_BYTES * 2) }).strict()).max(256) }).strict()
export type HarnessCacheSnapshot = z.infer<typeof harnessCacheSnapshotSchema>
async function cacheEntries(root: string, harnessId: string): Promise<HarnessCacheSnapshot['entries'] | null | undefined> {
  const folder = dir(root, harnessId)
  let listed: fs.DirectoryEntry[]
  try { listed = await fs.readdir(folder, { withFileTypes: true }) } catch { return undefined }
  if (!listed.length) return undefined
  const entries: HarnessCacheSnapshot['entries'] = []
  let bytes = 0
  for (const entry of listed.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entries.length >= 256) return null
    const read = await fs.readBoundedBase64(join(folder, entry.name), CACHE_SNAPSHOT_BYTES - bytes)
    if (!read) return null
    bytes += read.bytes
    entries.push({ name: entry.name, base64: read.base64 })
  }
  return entries
}
export async function captureHarnessCache(root: string, harnessId: string): Promise<HarnessCacheSnapshot | null> {
  const entries = await cacheEntries(root, harnessId)
  return entries ? { harnessId, entries } : null
}
export async function harnessCacheRevision(root: string, harnessId: string): Promise<string> {
  const entries = await cacheEntries(root, harnessId)
  return harnessCacheKey(entries === undefined ? { missing: true } : entries === null ? { unbounded: true, entries: (await fs.readdir(dir(root, harnessId)).catch(() => [])).sort() } : entries.map(entry => [entry.name, harnessCacheKey(entry.base64)]))
}
export async function restoreHarnessCache(root: string, raw: unknown, expectedRevision: string): Promise<void> {
  const snapshot = harnessCacheSnapshotSchema.parse(raw)
  if (await harnessCacheRevision(root, snapshot.harnessId) !== expectedRevision) throw Object.assign(new Error('The harness cache changed after it was cleared; restoring it would overwrite newer entries'), { code: 'UNDO_CONFLICT_STALE_TARGET', outcome: 'not-applied' })
  await fs.mkdir(dir(root, snapshot.harnessId), { recursive: true })
  for (const entry of snapshot.entries) await atomicWriteFile(join(dir(root, snapshot.harnessId), entry.name), fs.base64Bytes(entry.base64))
}
