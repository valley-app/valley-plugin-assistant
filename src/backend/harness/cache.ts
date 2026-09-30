import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import * as fs from '../filesystem'
import { join } from 'path-browserify'
import { ASSISTANT_HARNESS_CACHE_DIR } from './paths'
import type { HarnessCompletion } from '../../harnessTypes'
import { atomicWriteFile } from '../filesystem'

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
