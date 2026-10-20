import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
import type { DatasetRecord } from '@valley/plugin-sdk/datasets'
import { join } from 'path-browserify'
import { z } from 'zod'
import * as fs from './filesystem'
import { captureChat, chatEntriesOf, rewriteChat, type ChatSnapshot } from './threads'
import { runtimeScope, stopChatProcesses } from './processScopes'
import { harnessRunActive } from './harness/runner'
import { harnessCacheEntries, harnessCacheNamespace, writeHarnessCacheEntry, type HarnessCacheEntry } from './harness/cache'
import { ASSISTANT_DIR, ASSISTANT_HARNESS_RUNS_DIR } from './constants'
import type { SessionCoordinator } from './engine/coordinator'
import { boundedQuery } from './persistence/repositories'
type OwnerApi = PluginBackendOperationContext['api']

// Sealed test fixtures only. The host publishes no test-mode flag to plugins; core registers its sealed-test usage inverse
// ai:usage-forget only under the sealed fixture (src/main/modules/ai/commands.ts:160-170) and plugins cannot register ai:* ids,
// so a core descriptor for it is the signal. Every operation re-checks it before any effect.
export const SEALED_TEST_SIGNAL = 'ai:usage-forget'
export async function sealedTest(api: Pick<OwnerApi, 'commands'>): Promise<boolean> {
  try { const descriptor = await api.commands?.describe(SEALED_TEST_SIGNAL); return descriptor?.id === SEALED_TEST_SIGNAL && descriptor.location === 'core' } catch { return false }
}
const refuse = (code: string, message: string) => Object.assign(new Error(message), { code, outcome: 'not-applied', fatal: true, transient: false, retryable: false })
const unknown = (error: unknown) => Object.assign(error instanceof Error ? error : new Error(String(error)), { outcome: 'unknown', outcomeUnknown: true, fatal: true, transient: false, retryable: false })
// Conversation-keyed durable datasets (config.json); instruction_snapshots rows are keyed by instruction hash and restored by row.
const CONVERSATION_DATASETS = ['sessions', 'session_events', 'turn_queue', 'tool_executions', 'inbound_receipts', 'outbound_deliveries', 'questions', 'context_checkpoints', 'inbound_media_jobs', 'channel_actions', 'plans', 'plan_approvals', 'channel_replies', 'conversation_deletions', 'attachment_extractions', 'quiz_sessions']
type Row = DatasetRecord & { id: string }
async function rows(api: OwnerApi, dataset: string, where: Record<string, string> = {}, limit = 1000): Promise<Row[] | null> {
  const result: Row[] = []
  let cursor: string | undefined
  do {
    const page = await boundedQuery(api.data.dataset<Row>(dataset), { where, cursor, limit: 500 })
    result.push(...page.rows.map(row => JSON.parse(JSON.stringify(row)) as Row))
    if (result.length > limit) return null
    cursor = page.cursor
  } while (cursor)
  return result
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const exists = async (file: string, api: OwnerApi) => { const parent = file.slice(0, file.lastIndexOf('/')), name = file.slice(file.lastIndexOf('/') + 1); return (await fs.readdir(parent, { withFileTypes: true }, api).catch(() => [])).some(entry => entry.name === name) }

type SessionCapture = { kind: 'session'; conversationId: string; chat: ChatSnapshot; instructions: Row[]; home: boolean }
type HarnessCapture = { kind: 'harness'; harnessId: string; folders: Record<string, boolean>; runs: string[]; cache: HarnessCacheEntry[] }

export function createSealedTestOperations(vaultRoot: string, coordinator: Pick<SessionCoordinator, 'snapshot' | 'forget'>) {
  const captures = new Map<string, SessionCapture | HarnessCapture>()
  const keep = (value: SessionCapture | HarnessCapture) => { const id = crypto.randomUUID(); captures.set(id, value); while (captures.size > 32) captures.delete(captures.keys().next().value!); return id }
  const gate = async (api: OwnerApi) => { if (!await sealedTest(api)) throw refuse('TEST_MODE_REQUIRED', 'Assistant test fixtures are available only in a sealed test fixture') }
  const home = (id: string) => join(vaultRoot, ASSISTANT_DIR, 'harnesses', runtimeScope(id))
  const captureInput = z.object({ captureId: z.string().uuid() })
  const take = <T extends SessionCapture | HarnessCapture>(captureId: string, kind: T['kind']): T => { const value = captures.get(captureId); if (value?.kind !== kind) throw refuse('CAPTURE_UNAVAILABLE', 'The test capture is unknown or was already used'); return value as T }

  // Pre-turn capture: a bounded app chat with no coordinator session and no conversation rows, plus every instruction snapshot row.
  const captureSession = async (raw: unknown, api: OwnerApi) => {
    await gate(api)
    const { conversationId } = z.object({ conversationId: z.string().min(1).max(256) }).strict().parse(raw)
    if (coordinator.snapshot(conversationId)) throw refuse('SESSION_PRESENT', 'The conversation already has a coordinator session')
    for (const dataset of CONVERSATION_DATASETS) if ((await rows(api, dataset, { conversationId }, 0))?.length !== 0) throw refuse('SESSION_PRESENT', `The conversation already has ${dataset} rows`)
    const chat = await captureChat(vaultRoot, conversationId, api), instructions = await rows(api, 'instruction_snapshots')
    if (!chat || !instructions) throw refuse('CAPTURE_UNBOUNDED', 'The conversation or its instruction snapshots cannot be captured within bounds')
    const runtime = await fs.readdir(home(conversationId), undefined, api).catch(() => null)
    if (runtime?.length) throw refuse('SESSION_PRESENT', 'The conversation already has runtime home files')
    return { captureId: keep({ kind: 'session', conversationId, chat, instructions, home: runtime !== null }) }
  }
  // Drops exactly that conversation's coordinator session, its rows and the new or changed instruction snapshots, then rewrites the chat bytes.
  const forgetSession = async (raw: unknown, api: OwnerApi) => {
    await gate(api)
    const input = captureInput.extend({ conversationId: z.string().min(1).max(256) }).strict().parse(raw), capture = take<SessionCapture>(input.captureId, 'session')
    if (capture.conversationId !== input.conversationId) throw refuse('CAPTURE_MISMATCH', 'The capture belongs to another conversation')
    const state = coordinator.snapshot(input.conversationId)?.state
    if (state && !['IDLE', 'FAILED', 'INTERRUPTED', 'AWAITING_QUESTION'].includes(state)) throw refuse('SESSION_ACTIVE', 'Stop the conversation before it is forgotten')
    const instructions = await rows(api, 'instruction_snapshots'), present = await chatEntriesOf(vaultRoot, input.conversationId, api)
    if (!instructions || present === null) throw refuse('CAPTURE_UNBOUNDED', 'The conversation or its instruction snapshots exceed their bounds')
    const owned: Array<{ dataset: string; id: string }> = []
    for (const dataset of CONVERSATION_DATASETS) { const found = await rows(api, dataset, { conversationId: input.conversationId }); if (!found) throw refuse('CAPTURE_UNBOUNDED', `${dataset} rows exceed their bounds`); owned.push(...found.map(row => ({ dataset, id: row.id }))) }
    const before = new Map(capture.instructions.map(row => [row.id, row]))
    const operations = [
      ...owned.map(({ dataset, id }) => ({ dataset, operation: 'delete' as const, key: { id } })),
      ...instructions.filter(row => !before.has(row.id)).map(row => ({ dataset: 'instruction_snapshots', operation: 'delete' as const, key: { id: row.id } })),
      ...instructions.filter(row => before.has(row.id) && !same(row, before.get(row.id))).map(row => ({ dataset: 'instruction_snapshots', operation: 'upsert' as const, values: before.get(row.id)! })),
      ...capture.instructions.filter(row => !instructions.some(item => item.id === row.id)).map(row => ({ dataset: 'instruction_snapshots', operation: 'upsert' as const, values: row }))
    ]
    const turns = await coordinator.forget(input.conversationId)
    captures.delete(input.captureId)
    try {
      if (operations.length) await api.data.transaction(operations)
      await rewriteChat(vaultRoot, capture.chat, api)
      if (!capture.home) await stopChatProcesses(input.conversationId, true, api)
    } catch (error) { throw unknown(error) }
    return { conversationId: input.conversationId, turns, rows: owned.length, instructions: operations.length - owned.length }
  }

  const harnessFolders = (id: string) => ({ runs: join(vaultRoot, ASSISTANT_HARNESS_RUNS_DIR, id) })
  const chain = (id: string) => [ASSISTANT_HARNESS_RUNS_DIR, `${ASSISTANT_HARNESS_RUNS_DIR}/${id}`].map(rel => join(vaultRoot, rel))
  const captureHarness = async (raw: unknown, api: OwnerApi) => {
    await gate(api)
    const { id } = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/) }).strict().parse(raw), folders = harnessFolders(id)
    const runs = await fs.readdir(folders.runs, undefined, api).catch(() => [] as string[]), cache = await harnessCacheEntries(id, api)
    if (runs.length >= 50 || cache === null) throw refuse('CAPTURE_UNBOUNDED', 'The harness history or cache cannot be captured within bounds')
    return { captureId: keep({ kind: 'harness', harnessId: id, folders: Object.fromEntries(await Promise.all(chain(id).map(async folder => [folder, await exists(folder, api)]))), runs: runs.sort(), cache: cache ?? [] }) }
  }
  // Deletes exactly the run record the harness run wrote and returns the harness cache namespace to its captured entries.
  const forgetHarness = async (raw: unknown, api: OwnerApi) => {
    await gate(api)
    const input = captureInput.extend({ runId: z.string().uuid() }).strict().parse(raw), capture = take<HarnessCapture>(input.captureId, 'harness'), folders = harnessFolders(capture.harnessId)
    if (harnessRunActive(input.runId)) throw refuse('RUN_ACTIVE', 'Cancel the harness run or wait for it before it is forgotten')
    const record = `${input.runId}.json`, runs = (await fs.readdir(folders.runs, undefined, api).catch(() => [] as string[])).sort(), current = await harnessCacheEntries(capture.harnessId, api)
    if (capture.runs.includes(record) || !same(runs, [...capture.runs, record].sort())) throw refuse('RUN_MISMATCH', 'The harness history differs from the capture plus exactly this run')
    if (current === null) throw refuse('CAPTURE_UNBOUNDED', 'The harness cache exceeds its bounds')
    const run = JSON.parse(await fs.readFile(join(folders.runs, record), 'utf8', api)) as { id?: string; harnessId?: string; status?: string }
    if (run.id !== input.runId || run.harnessId !== capture.harnessId || run.status === 'running') throw refuse('RUN_MISMATCH', 'The run record is not this finished harness run')
    captures.delete(input.captureId)
    const cache = current ?? [], kept = new Map(capture.cache.map(entry => [entry.key, JSON.stringify(entry.value)])), written = cache.filter(entry => kept.get(entry.key) !== JSON.stringify(entry.value)).map(entry => entry.key)
    try {
      await fs.rm(join(folders.runs, record), { force: true }, api)
      for (const entry of cache) if (!kept.has(entry.key)) await api.cache.delete(harnessCacheNamespace(capture.harnessId), entry.key)
      for (const entry of capture.cache) if (written.includes(entry.key) || !cache.some(item => item.key === entry.key)) await writeHarnessCacheEntry(capture.harnessId, entry, api)
      for (const folder of chain(capture.harnessId).reverse()) if (!capture.folders[folder] && !(await fs.readdir(folder, undefined, api).catch(() => [''])).length) await fs.rm(folder, { recursive: true, force: true }, api)
    } catch (error) { throw unknown(error) }
    return { harnessId: capture.harnessId, runId: input.runId, cache: written.sort() }
  }
  return { sealed: sealedTest, captureSession, forgetSession, captureHarness, forgetHarness }
}
