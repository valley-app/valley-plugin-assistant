import * as fs from './filesystem'
import path from 'path-browserify'
import type { PendingApprovalRecord } from '@valley/plugin-sdk/guard/types'
import { atomicWriteFile } from './filesystem'
import { runtimeDir } from './paths'
import { runExclusive } from './fileQueue'

/**
 * Durable server-side store of pending channel approvals (C8). A Telegram approval
 * is in-memory in the renderer (it carries the live promise resolver), but its
 * record is mirrored here so that after an app restart a button tapped on an old
 * message is recognized — the renderer recovers the stale set on launch, expires
 * them (the dead run can't be resumed), and clears the file. Writes go through the
 * per-file queue so concurrent add/remove can't corrupt the JSON (C16).
 */
function pendingFile(vaultRoot: string): string {
  return path.join(runtimeDir(vaultRoot), 'pending-approvals.json')
}

type PendingFile = Record<string, PendingApprovalRecord>

async function read(vaultRoot: string): Promise<PendingFile> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(pendingFile(vaultRoot), 'utf8'))
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}
  const out: PendingFile = {}
  for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const r = raw as Partial<PendingApprovalRecord>
    if (r && typeof r.requestId === 'string' && typeof r.expiresAt === 'number') out[id] = r as PendingApprovalRecord
  }
  return out
}

/** Record one pending approval (idempotent by requestId). Read-modify-write under
 *  one lock so concurrent add/remove can't race (the atomic write is inlined to
 *  avoid nesting the per-path queue, which would self-deadlock). */
export async function addPending(vaultRoot: string, record: PendingApprovalRecord): Promise<void> {
  await runExclusive(pendingFile(vaultRoot), async () => {
    const file = await read(vaultRoot)
    file[record.requestId] = record
    await fs.mkdir(runtimeDir(vaultRoot), { recursive: true })
    await atomicWriteFile(pendingFile(vaultRoot), JSON.stringify(file, null, 2))
  })
}

/** Forget one pending approval (resolved / expired / recovered). */
export async function removePending(vaultRoot: string, requestId: string): Promise<void> {
  await runExclusive(pendingFile(vaultRoot), async () => {
    const file = await read(vaultRoot)
    if (!(requestId in file)) return
    delete file[requestId]
    await atomicWriteFile(pendingFile(vaultRoot), JSON.stringify(file, null, 2))
  })
}

/** Every persisted pending approval (newest first), for crash recovery on launch. */
export async function listPending(vaultRoot: string): Promise<PendingApprovalRecord[]> {
  const file = await read(vaultRoot)
  return Object.values(file).sort((a, b) => b.createdAt - a.createdAt)
}
