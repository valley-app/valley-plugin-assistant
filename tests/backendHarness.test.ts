// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { initBackend } from '../src/backend/runtime'
import { cancelAllHarnessRuns, cancelHarnessRun, startHarnessRun } from '../src/backend/harness/runner'
import { normalizeHarnessResult } from '../src/backend/harness/workerRuntime'
import { harnessCacheKey } from '../src/backend/harness/cache'

const fixture = vi.hoisted(() => ({
  mode: 'complete', events: [] as Array<Record<string, any>>, workers: [] as Array<{ stopped: boolean }>,
  complete: vi.fn(), cache: vi.fn(),
  harness: {
    manifest: { id: 'fixture', version: '1' }, digest: 'digest', url: 'blob:fixture',
    config: { execution: { timeoutMs: 20, maxResponseBytes: 65536, maxTurns: 2, maxConcurrency: 2 },
      retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10 }, cache: { maxAgeDays: 1, maxSizeMb: 1 } },
    cases: [{ id: 'one', name: 'One', weight: 1 }]
  }
}))
vi.mock('../src/backend/engine', () => ({ runDetailed: fixture.complete }))
vi.mock('../src/backend/store', () => ({ listConnections: async () => [{ id: 'fixture', provider: 'fixture', baseUrl: 'https://fixture.example' }] }))
vi.mock('../src/backend/pricing', () => ({ costFor: () => 0 }))
vi.mock('../src/backend/filesystem', () => ({ readdir: async () => [], stat: vi.fn(), readFile: vi.fn(), rm: vi.fn(), atomicWriteFile: async () => undefined }))
vi.mock('../src/backend/runtime', async (original) => ({ ...(await original<typeof import('../src/backend/runtime')>()), emitDriverEvent: (_driver: string, _event: string, value: Record<string, any>) => fixture.events.push(structuredClone(value)), withBackgroundOperation: (_root: string, run: () => unknown) => run() }))
vi.mock('../src/backend/harness/packages', () => ({ ensureHarnessPackages: async () => undefined, getLoadedHarness: () => fixture.harness, listHarnessPackageStatuses: () => [{ id: 'fixture', settings: {} }] }))
vi.mock('../src/backend/harness/cache', async (original) => ({ ...await original<typeof import('../src/backend/harness/cache')>(), readHarnessCache: fixture.cache, writeHarnessCache: async () => undefined, clearHarnessCache: async () => undefined }))
vi.mock('../src/backend/harness/workerRuntime', async (original) => ({
  ...await original<typeof import('../src/backend/harness/workerRuntime')>(),
  createHarnessWorker(data: { caseId: string }) {
    class FixtureWorker extends EventTarget {
      stopped = false
      constructor() {
        super()
        fixture.workers.push(this)
        queueMicrotask(() => {
          this.send({ type: 'case-ready' })
          if (fixture.mode !== 'hang') this.send({ type: 'host-call', id: '1', method: 'complete', payload: { caseId: data.caseId, turn: fixture.mode === 'invalid-turn' ? 99 : 1, request: { messages: [{ role: 'user', content: 'hello' }] } } })
        })
      }
      send(data: unknown) { if (!this.stopped) this.dispatchEvent(new MessageEvent('message', { data })) }
      postMessage(message: { error?: { message: string } }) {
        if (message.error) this.send({ type: 'worker-error', error: message.error.message })
        else this.send({ type: 'case-result', result: { status: 'pass', score: fixture.mode === 'invalid-result' ? NaN : 1 } })
      }
      terminate() { this.stopped = true }
    }
    return new FixtureWorker()
  }
}))

const target = [{ provider: 'fixture', model: 'fixture' }]
async function finished(id: string): Promise<Record<string, any>> {
  await vi.waitFor(() => expect(fixture.events.find((event) => event.runId === id && ['completed', 'cancelled', 'error'].includes(event.type))).toBeDefined())
  return fixture.events.find((event) => event.runId === id && ['completed', 'cancelled', 'error'].includes(event.type))!.run
}

beforeEach(() => {
  cancelAllHarnessRuns()
  vi.clearAllMocks()
  initBackend({ rpc: { emit: vi.fn() } } as unknown as PluginBackendApi)
  fixture.events.length = 0
  fixture.workers.length = 0
  fixture.mode = 'complete'
  fixture.harness.cases = [{ id: 'one', name: 'One', weight: 1 }]
  fixture.complete.mockResolvedValue({ text: 'hello', toolCalls: [], events: [], inputTokens: 3, outputTokens: 2, latencyMs: 1 })
  fixture.cache.mockResolvedValue(null)
})

it('retries transient completion failures and preserves metering', async () => {
  fixture.complete.mockRejectedValueOnce(new Error('HTTP 429 Retry-After: 0'))
  const run = await startHarnessRun('/vault', 'fixture', target)
  const result = await finished(run.id)
  expect(fixture.complete).toHaveBeenCalledTimes(2)
  expect(result.targets[0].cases[0]).toMatchObject({ status: 'pass', hostMetrics: { retries: 1, inputTokens: 3, outputTokens: 2 } })
  expect(fixture.events.some((event) => event.type === 'retry')).toBe(true)
})

it('respects per-model concurrency while completing all cases', async () => {
  fixture.harness.cases = ['one', 'two', 'three'].map((id) => ({ id, name: id, weight: 1 }))
  let active = 0, peak = 0
  fixture.complete.mockImplementation(async () => {
    peak = Math.max(peak, ++active)
    await new Promise((resolve) => setTimeout(resolve, 10))
    active--
    return { text: '', toolCalls: [], events: [], inputTokens: 0, outputTokens: 0, latencyMs: 1 }
  })
  const run = await startHarnessRun('/vault', 'fixture', target, { concurrency: 2 })
  expect((await finished(run.id)).targets[0].cases).toHaveLength(3)
  expect(peak).toBe(2)
})

it.each(['hang', 'invalid-turn', 'invalid-result'])('ends an invalid or stalled worker: %s', async (mode) => {
  fixture.mode = mode
  const run = await startHarnessRun('/vault', 'fixture', target)
  const result = await finished(run.id)
  expect(result.targets[0].cases[0].status).toBe('error')
  expect(fixture.workers.every((worker) => worker.stopped)).toBe(true)
  if (mode === 'invalid-turn') expect(fixture.complete).not.toHaveBeenCalled()
})

it('cancels active cases and terminates their workers', async () => {
  fixture.mode = 'hang'
  const run = await startHarnessRun('/vault', 'fixture', target)
  expect(cancelHarnessRun(run.id)).toBe(true)
  expect((await finished(run.id)).status).toBe('cancelled')
  expect(fixture.workers.every((worker) => worker.stopped)).toBe(true)
})

it('normalizes results and keeps cache identity stable across property order', () => {
  expect(normalizeHarnessResult({ status: 'pass' })).toEqual({ status: 'pass', score: 1, assertions: [], metrics: {} })
  expect(() => normalizeHarnessResult({ status: 'pass', metrics: { count: Infinity } })).toThrow()
  expect(harnessCacheKey({ model: 'one', settings: { a: 1, b: 2 } })).toBe(harnessCacheKey({ settings: { b: 2, a: 1 }, model: 'one' }))
})
