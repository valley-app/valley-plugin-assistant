import './backendFileFixture'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  cacheGet,
  cacheInvalidatePrefix,
  cacheSet,
  clearCache,
  dedupeInFlight,
  hashKey,
  readCacheStats,
  recordCacheHit
} from '../src/backend/cache'

/**
 * The safe API-metadata cache (Phase 5, spec §8): store/serve by key + TTL, count
 * hits with the tokens/cost they saved, expire on TTL, and survive a fresh read.
 * (What is *eligible* to be cached — no tools/writes/secrets — is gated by the
 * driver callers; this module only stores what it's handed.)
 */
let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'aicache-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('assistant api cache', () => {
  it('is a miss before set, a hit while fresh, and a miss once expired', async () => {
    expect(await cacheGet(root, 'k')).toBeUndefined()
    await cacheSet(root, 'k', { models: ['a'] }, 10_000)
    expect(await cacheGet<{ models: string[] }>(root, 'k')).toEqual({ models: ['a'] })
    // Re-read from disk (no in-memory state) still hits.
    expect(await cacheGet<{ models: string[] }>(root, 'k')).toEqual({ models: ['a'] })

    await cacheSet(root, 'short', 1, -1) // already expired
    expect(await cacheGet(root, 'short')).toBeUndefined()
  })

  it('counts hits with the tokens/cost they saved', async () => {
    await recordCacheHit(root, 'modelList')
    await recordCacheHit(root, 'completion', { inputTokens: 100, outputTokens: 50, costUsd: 0.002 })
    const stats = await readCacheStats(root)
    expect(stats.hits).toBe(2)
    expect(stats.byKind.modelList).toBe(1)
    expect(stats.byKind.completion).toBe(1)
    expect(stats.savedInputTokens).toBe(100)
    expect(stats.savedOutputTokens).toBe(50)
    expect(stats.savedCostUsd).toBeCloseTo(0.002)
  })

  it('reports the live entry count and clears on demand', async () => {
    await cacheSet(root, 'a', 1, 10_000)
    await cacheSet(root, 'b', 2, 10_000)
    await cacheSet(root, 'c', 3, -1) // expired → not counted live
    expect((await readCacheStats(root)).entries).toBe(2)

    await recordCacheHit(root, 'balance')
    await clearCache(root)
    const stats = await readCacheStats(root)
    expect(stats.entries).toBe(0)
    expect(stats.hits).toBe(0)
    expect(await cacheGet(root, 'a')).toBeUndefined()
  })

  it('hashKey is stable and partitions distinct inputs', () => {
    expect(hashKey('abc')).toBe(hashKey('abc'))
    expect(hashKey('abc')).not.toBe(hashKey('abd'))
  })

  it('serializes concurrent sets without losing entries (C16)', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => cacheSet(root, `k${i}`, i, 10_000)))
    expect((await readCacheStats(root)).entries).toBe(10)
  })

  it('dedupeInFlight shares one call among concurrent requesters, then clears', async () => {
    let calls = 0
    let release: (v: string) => void = () => {}
    const gated = (): Promise<string> => {
      calls += 1
      return new Promise((resolve) => {
        release = resolve
      })
    }
    const p1 = dedupeInFlight('same', gated)
    const p2 = dedupeInFlight('same', gated)
    release('shared')
    expect(await p1).toBe('shared')
    expect(await p2).toBe('shared')
    expect(calls).toBe(1)
    // Settled → next call goes out fresh.
    const p3 = dedupeInFlight('same', async () => 'fresh')
    expect(await p3).toBe('fresh')
    expect(calls).toBe(1)
  })

  it('cacheInvalidatePrefix drops matching keys and keeps the rest', async () => {
    await cacheSet(root, 'models:openai:https://a', 1, 10_000)
    await cacheSet(root, 'models:openai:https://b', 2, 10_000)
    await cacheSet(root, 'models:gemini:https://c', 3, 10_000)
    await cacheInvalidatePrefix(root, 'models:openai:')
    expect(await cacheGet(root, 'models:openai:https://a')).toBeUndefined()
    expect(await cacheGet(root, 'models:openai:https://b')).toBeUndefined()
    expect(await cacheGet(root, 'models:gemini:https://c')).toBe(3)
  })
})
