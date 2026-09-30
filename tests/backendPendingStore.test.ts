import './backendFileFixture'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { PendingApprovalRecord } from '@valley/plugin-sdk/guard/types'
import { addPending, listPending, removePending } from '../src/backend/pending'

/**
 * The durable server-side pending-approval store (C8): records survive on disk so
 * a Telegram button tapped after a restart can be recognized. Concurrent add/remove
 * serialize by path (the file never corrupts), and a resolve clears its record.
 */
let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'pending-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const rec = (id: string, over: Partial<PendingApprovalRecord> = {}): PendingApprovalRecord => ({
  requestId: id,
  channelId: 'telegram',
  chatRef: '5',
  chatId: 'tg-telegram-5',
  actionLabel: 'write_note',
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  ...over
})

describe('pending approval store', () => {
  it('persists, lists, and removes records (survives a fresh read)', async () => {
    await addPending(root, rec('r1'))
    await addPending(root, rec('r2', { chatRef: '6' }))
    expect((await listPending(root)).map((r) => r.requestId).sort()).toEqual(['r1', 'r2'])

    await removePending(root, 'r1')
    const left = await listPending(root)
    expect(left.map((r) => r.requestId)).toEqual(['r2'])
    // A brand-new read (no in-memory state) still sees the durable record.
    expect((await listPending(root))[0].chatRef).toBe('6')
  })

  it('serializes concurrent adds without dropping records (C16)', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => addPending(root, rec(`c${i}`))))
    expect((await listPending(root)).length).toBe(12)
  })

  it('tolerates a missing/garbage file as empty', async () => {
    expect(await listPending(root)).toEqual([])
    await fs.mkdir(join(root, '.valley', 'assistant', 'runtime'), { recursive: true })
    await fs.writeFile(join(root, '.valley', 'assistant', 'runtime', 'pending-approvals.json'), 'not json', 'utf8')
    expect(await listPending(root)).toEqual([])
    // …and a write recovers cleanly over the garbage.
    await addPending(root, rec('ok'))
    expect((await listPending(root)).map((r) => r.requestId)).toEqual(['ok'])
  })
})
