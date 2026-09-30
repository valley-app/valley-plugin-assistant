import './backendFileFixture'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { queuedAppendJsonl, queuedWrite, queuedWriteJson, runExclusive } from '../src/backend/fileQueue'

/**
 * C16 — the main-process per-file write queue. Operations on one path serialize
 * (so a full rewrite never overlaps an append and corrupts the file), appends
 * preserve enqueue order, and a half-failed full rewrite leaves the previous
 * file intact and readable (atomic temp+rename).
 */

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'filequeue-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('fileQueue', () => {
  it('serializes concurrent appends by path and preserves order', async () => {
    const file = join(root, 'a', 'log.jsonl')
    // Fire 50 appends without awaiting individually — order must be by enqueue.
    const ps = Array.from({ length: 50 }, (_, i) => queuedAppendJsonl(file, [{ n: i }]))
    await Promise.all(ps)
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(50)
    expect(lines.map((l) => (JSON.parse(l) as { n: number }).n)).toEqual(Array.from({ length: 50 }, (_, i) => i))
  })

  it('runExclusive does not overlap two ops on the same key', async () => {
    const order: string[] = []
    let active = 0
    const op = (id: string) => async (): Promise<void> => {
      expect(active).toBe(0) // never two at once for one key
      active++
      order.push(`${id}-start`)
      await new Promise((r) => setTimeout(r, 5))
      order.push(`${id}-end`)
      active--
    }
    await Promise.all([runExclusive('k', op('A')), runExclusive('k', op('B'))])
    expect(order).toEqual(['A-start', 'A-end', 'B-start', 'B-end'])
  })

  it('runs ops on different keys concurrently', async () => {
    const order: string[] = []
    await Promise.all([
      runExclusive('x', async () => {
        order.push('x-start')
        await new Promise((r) => setTimeout(r, 10))
        order.push('x-end')
      }),
      runExclusive('y', async () => {
        order.push('y-start')
        order.push('y-end')
      })
    ])
    // y (no delay) finishes before x even though x was enqueued first.
    expect(order.indexOf('y-end')).toBeLessThan(order.indexOf('x-end'))
  })

  it('full rewrites + appends to one path serialize (last rewrite then appends apply in order)', async () => {
    const file = join(root, 'mix.jsonl')
    await queuedWrite(file, '{"seed":true}\n')
    await Promise.all([queuedAppendJsonl(file, [{ n: 1 }]), queuedAppendJsonl(file, [{ n: 2 }])])
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n')
    expect(lines[0]).toBe('{"seed":true}')
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ seed: true }, { n: 1 }, { n: 2 }])
  })

  it('a half-failed full rewrite leaves the previous file readable', async () => {
    const file = join(root, 'cfg.json')
    await queuedWriteJson(file, { ok: 1 })
    // A circular value throws inside JSON.stringify before any byte is written.
    const circular: Record<string, unknown> = {}
    circular.self = circular
    await expect(queuedWriteJson(file, circular)).rejects.toThrow()
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ ok: 1 })
    // A failed op must not wedge the queue: the next write still lands.
    await queuedWriteJson(file, { ok: 2 })
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ ok: 2 })
  })

  it('queuedAppendJsonl is a no-op for an empty record list', async () => {
    const file = join(root, 'empty.jsonl')
    await queuedAppendJsonl(file, [])
    await expect(fs.access(file)).rejects.toThrow() // never created
  })
})
