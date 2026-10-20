import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import type { HarnessCompletion } from '../../harnessTypes'
import { backendApi } from '../runtime'
import { z } from 'zod'

type CacheOwner = Pick<PluginBackendApi, 'cache'>
interface CacheEntry {
  createdAt: number
  expiresAt?: number
  value: HarnessCompletion
}
const DAY_MS = 86_400_000
const ENTRY_BYTES = 1024 * 1024
const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength

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

export function harnessCacheNamespace(harnessId: string): string {
  const safe = harnessId.replace(/[^A-Za-z0-9._-]/g, '-')
  const namespace = `evaluations.${safe}`
  return safe === harnessId && namespace.length <= 64 ? namespace : `evaluations.${safe.slice(0, 43)}.${harnessCacheKey(harnessId).slice(0, 8)}`
}

export async function readHarnessCache(harnessId: string, key: string, maxAgeDays: number): Promise<HarnessCompletion | null> {
  try {
    const parsed = await backendApi().cache.get<CacheEntry>(harnessCacheNamespace(harnessId), key)
    if (!parsed?.createdAt || Date.now() - parsed.createdAt > maxAgeDays * DAY_MS) return null
    return { ...parsed.value, cached: true }
  } catch {
    return null
  }
}

export async function writeHarnessCache(harnessId: string, key: string, value: HarnessCompletion, maxAgeDays: number, maxSizeMb: number): Promise<void> {
  const ttlMs = maxAgeDays * DAY_MS, createdAt = Date.now()
  const entry: CacheEntry = { createdAt, expiresAt: createdAt + ttlMs, value }
  const bytes = bytesOf(entry)
  if (bytes > ENTRY_BYTES) return
  const namespace = harnessCacheNamespace(harnessId)
  try {
    await backendApi().cache.set(namespace, key, entry, { ttlMs })
    await withSizes(namespace, sizes => { sizes[key] = [bytes, createdAt + ttlMs] }, maxSizeMb * 1024 * 1024)
  } catch {}
}

// Per-harness size limit (config cache.maxSizeMb): a ledger of entry bytes and expiry, oldest entries evicted first.
const SIZES_NAMESPACE = 'evaluation-sizes', SIZES_BYTES = 4 * 1024 * 1024
type Sizes = Record<string, [bytes: number, expiresAt: number]>
const sizeQueues = new Map<string, Promise<void>>()
function withSizes(namespace: string, change: (sizes: Sizes) => void, maxBytes: number): Promise<void> {
  const run = async (): Promise<void> => {
    const api = backendApi(), now = Date.now()
    const stored = await api.cache.get<Sizes>(SIZES_NAMESPACE, namespace)
    const sizes: Sizes = Object.fromEntries(Object.entries(stored && typeof stored === 'object' ? stored : {}).filter(([, item]) => Array.isArray(item) && item[1] > now))
    change(sizes)
    const oldest = Object.entries(sizes).sort((a, b) => a[1][1] - b[1][1])
    let total = oldest.reduce((sum, [, [bytes]]) => sum + bytes, 0)
    for (const [key, [bytes]] of oldest) {
      if (total <= maxBytes && bytesOf(sizes) <= SIZES_BYTES) break
      await api.cache.delete(namespace, key)
      delete sizes[key]
      total -= bytes
    }
    if (Object.keys(sizes).length) await api.cache.set(SIZES_NAMESPACE, namespace, sizes)
    else await api.cache.delete(SIZES_NAMESPACE, namespace)
  }
  const next = (sizeQueues.get(namespace) ?? Promise.resolve()).then(run, run)
  const settled = next.catch(() => undefined)
  sizeQueues.set(namespace, settled)
  void settled.then(() => { if (sizeQueues.get(namespace) === settled) sizeQueues.delete(namespace) })
  return next
}

export async function clearHarnessCache(harnessId: string): Promise<void> {
  const namespace = harnessCacheNamespace(harnessId)
  await backendApi().cache.clear({ namespace })
  await backendApi().cache.delete(SIZES_NAMESPACE, namespace).catch(() => false)
}

// clear-cache revert: the exact cache entries of one harness, rewritten only while the namespace is unchanged since the clear.
const CACHE_SNAPSHOT_BYTES = 512 * 1024, CACHE_SNAPSHOT_ENTRIES = 256
const harnessCacheEntrySchema = z.object({ key: z.string().min(1).max(256), value: z.unknown() }).strict()
export const harnessCacheSnapshotSchema = z.object({ harnessId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), entries: z.array(harnessCacheEntrySchema).max(CACHE_SNAPSHOT_ENTRIES) }).strict().refine(snapshot => bytesOf(snapshot.entries) <= CACHE_SNAPSHOT_BYTES * 2)
export type HarnessCacheSnapshot = z.infer<typeof harnessCacheSnapshotSchema>
export type HarnessCacheEntry = z.infer<typeof harnessCacheEntrySchema>
export async function harnessCacheEntries(harnessId: string, api: CacheOwner = backendApi()): Promise<HarnessCacheEntry[] | null | undefined> {
  const namespace = harnessCacheNamespace(harnessId)
  const listed = await api.cache.keys(namespace, { limit: CACHE_SNAPSHOT_ENTRIES })
  if (listed.more) return null
  const entries: HarnessCacheEntry[] = []
  let bytes = 0
  for (const key of [...listed.keys].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
    const value = await api.cache.get<unknown>(namespace, key)
    if (value === undefined) continue
    bytes += bytesOf(value)
    if (bytes > CACHE_SNAPSHOT_BYTES) return null
    entries.push({ key, value })
  }
  return entries.length ? entries : undefined
}
export async function writeHarnessCacheEntry(harnessId: string, entry: HarnessCacheEntry, api: CacheOwner = backendApi()): Promise<void> {
  const expiresAt = (entry.value as Partial<CacheEntry> | null)?.expiresAt
  if (typeof expiresAt === 'number' && expiresAt <= Date.now()) return
  await api.cache.set(harnessCacheNamespace(harnessId), entry.key, entry.value, typeof expiresAt === 'number' ? { ttlMs: expiresAt - Date.now() } : {})
}
export async function captureHarnessCache(harnessId: string): Promise<HarnessCacheSnapshot | null> {
  const entries = await harnessCacheEntries(harnessId)
  return entries ? { harnessId, entries } : null
}
export async function harnessCacheRevision(harnessId: string): Promise<string> {
  const entries = await harnessCacheEntries(harnessId)
  return harnessCacheKey(entries === undefined ? { missing: true } : entries === null ? { unbounded: true, keys: (await backendApi().cache.keys(harnessCacheNamespace(harnessId), { limit: CACHE_SNAPSHOT_ENTRIES + 1 })).keys.sort() } : entries.map(entry => [entry.key, harnessCacheKey(entry.value)]))
}
export async function restoreHarnessCache(raw: unknown, expectedRevision: string): Promise<void> {
  const snapshot = harnessCacheSnapshotSchema.parse(raw)
  if (await harnessCacheRevision(snapshot.harnessId) !== expectedRevision) throw Object.assign(new Error('The harness cache changed after it was cleared; restoring it would overwrite newer entries'), { code: 'UNDO_CONFLICT_STALE_TARGET', outcome: 'not-applied' })
  for (const entry of snapshot.entries) await writeHarnessCacheEntry(snapshot.harnessId, entry)
  await withSizes(harnessCacheNamespace(snapshot.harnessId), sizes => {
    for (const entry of snapshot.entries) {
      const expiresAt = (entry.value as Partial<CacheEntry> | null)?.expiresAt
      if (typeof expiresAt === 'number') sizes[entry.key] = [bytesOf(entry.value), expiresAt]
    }
  }, Number.POSITIVE_INFINITY)
}
