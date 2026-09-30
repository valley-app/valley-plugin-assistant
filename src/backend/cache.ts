import type { AiCacheStats } from '../types'
import { cacheClearNamespace, cacheReadJson, cacheUpdateJson } from './cacheFiles'

/**
 * A deliberately small, safe API-metadata cache (Phase 5, spec §8) under
 * `.valley/cache/assistant/api/`. It caches only **safe** reads — provider model
 * lists, balances, and deterministic *no-tool* one-shot completions — and **never**
 * tool-using agent loops, write actions, live channel turns, or anything carrying
 * secrets (the callers gate that; this module just stores by key + TTL). Hits are
 * counted so the saved tokens/cost surface in Usage & Billing.
 *
 * Two files, both written through the per-path queue (C16): `data.json` holds the
 * keyed entries; `stats.json` the running hit tally. A miss/expired entry simply
 * returns undefined — caching can never change a result, only skip a network call.
 */
export type CacheKind = 'modelList' | 'balance' | 'completion'

interface CacheEntry {
  value: unknown
  expiresAt: number
}
type CacheData = Record<string, CacheEntry>

interface CacheStatsFile {
  hits: number
  savedInputTokens: number
  savedOutputTokens: number
  savedCostUsd: number
  byKind: { modelList: number; balance: number; completion: number }
}

const CACHE_NAMESPACE = 'assistant/api'
const ENTRIES_KEY = 'entries.json'
const STATS_KEY = 'stats.json'

const emptyStats = (): CacheStatsFile => ({
  hits: 0,
  savedInputTokens: 0,
  savedOutputTokens: 0,
  savedCostUsd: 0,
  byKind: { modelList: 0, balance: 0, completion: 0 }
})

/** A stable, short, non-cryptographic hash (djb2) for request keys — enough to
 *  partition a cache; never used for anything security-sensitive. */
export function hashKey(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) h = (h * 33) ^ input.charCodeAt(i)
  return (h >>> 0).toString(36)
}

/** In-flight promise dedupe for provider metadata (model lists, balances,
 *  status probes): concurrent identical requests share one network call.
 *  Memory-only — entries clear as soon as the promise settles. */
const inFlight = new Map<string, Promise<unknown>>()

export function dedupeInFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = inFlight.get(key)
  if (hit) return hit as Promise<T>
  const p = fn().finally(() => inFlight.delete(key))
  inFlight.set(key, p)
  return p
}

/** Drop cached entries whose key starts with `prefix` — called when a provider's
 *  key or base URL changes so stale metadata can't outlive the credential. */
export async function cacheInvalidatePrefix(vaultRoot: string, prefix: string): Promise<void> {
  await cacheUpdateJson<CacheData>(vaultRoot, CACHE_NAMESPACE, ENTRIES_KEY, {}, (data) => {
    for (const key of Object.keys(data)) {
      if (key.startsWith(prefix)) delete data[key]
    }
  })
}

/** A cached value for `key` if present and unexpired; else undefined (a miss). */
export async function cacheGet<T>(vaultRoot: string, key: string): Promise<T | undefined> {
  const data = await cacheReadJson<CacheData>(vaultRoot, CACHE_NAMESPACE, ENTRIES_KEY, {})
  const entry = data[key]
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) return undefined
  return entry.value as T
}

/** Store `value` under `key` for `ttlMs`, pruning any expired entries. Serialized by path. */
export async function cacheSet(vaultRoot: string, key: string, value: unknown, ttlMs: number): Promise<void> {
  await cacheUpdateJson<CacheData>(vaultRoot, CACHE_NAMESPACE, ENTRIES_KEY, {}, (data) => {
    const now = Date.now()
    for (const [entryKey, entry] of Object.entries(data)) if (entry.expiresAt <= now) delete data[entryKey]
    data[key] = { value, expiresAt: now + ttlMs }
  })
}

/** Count one cache hit (and any token/cost it saved), for the Usage & Billing surface. */
export async function recordCacheHit(
  vaultRoot: string,
  kind: CacheKind,
  saved: { inputTokens?: number; outputTokens?: number; costUsd?: number } = {}
): Promise<void> {
  await cacheUpdateJson<CacheStatsFile>(vaultRoot, CACHE_NAMESPACE, STATS_KEY, emptyStats(), (stats) => {
    stats.byKind = { ...emptyStats().byKind, ...stats.byKind }
    stats.hits += 1
    stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1
    stats.savedInputTokens += Math.max(0, Math.round(saved.inputTokens ?? 0))
    stats.savedOutputTokens += Math.max(0, Math.round(saved.outputTokens ?? 0))
    stats.savedCostUsd += Math.max(0, saved.costUsd ?? 0)
  })
}

/** The cache stats + live entry count, for the Usage & Billing card. */
export async function readCacheStats(vaultRoot: string): Promise<AiCacheStats> {
  const [stats, data] = await Promise.all([
    cacheReadJson<CacheStatsFile>(vaultRoot, CACHE_NAMESPACE, STATS_KEY, emptyStats()),
    cacheReadJson<CacheData>(vaultRoot, CACHE_NAMESPACE, ENTRIES_KEY, {})
  ])
  const now = Date.now()
  const entries = Object.values(data).filter((e) => e.expiresAt > now).length
  return { ...emptyStats(), ...stats, byKind: { ...emptyStats().byKind, ...stats.byKind }, entries }
}

/** Clear all cached entries and reset the hit tally (explicit user action). */
export async function clearCache(vaultRoot: string): Promise<void> {
  await cacheClearNamespace(vaultRoot, CACHE_NAMESPACE)
}
