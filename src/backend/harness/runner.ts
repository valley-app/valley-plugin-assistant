import { t, backendApi, backendClosing } from '../runtime'
import * as fs from '../filesystem'
import { join } from 'path-browserify'
import { ASSISTANT_HARNESS_RUNS_DIR } from './paths'
import type {
  HarnessCaseResult,
  HarnessCaseRun,
  HarnessCompletion,
  HarnessCompletionRequest,
  HarnessEvent,
  HarnessRun,
  HarnessRunOptions,
  HarnessTarget,
  HarnessTargetRun
} from '../../harnessTypes'
import { redactSecrets } from '@valley/plugin-sdk'
import { runDetailed } from '../engine'
import { costFor } from '../pricing'
import { listConnections } from '../store'
import { emitDriverEvent } from '../runtime'
import { atomicWriteFile } from '../filesystem'
import { withBackgroundOperation } from '../runtime'
import { clearHarnessCache, harnessCacheKey, readHarnessCache, writeHarnessCache } from './cache'
import { ensureHarnessPackages, getLoadedHarness, listHarnessPackageStatuses } from './packages'
import { createHarnessWorker, normalizeHarnessResult } from './workerRuntime'

const DEFAULT_CONCURRENCY = 3
const activeRuns = new Map<string, AbortController>()
const modelQueues = new Map<string, { active: number; waiting: (() => void)[] }>()
const modelCooldownUntil = new Map<string, number>()

function emit(event: HarnessEvent): void {
  emitDriverEvent('ai', 'harness', event)
}

function historyDir(root: string, harnessId: string): string {
  return join(root, ASSISTANT_HARNESS_RUNS_DIR, harnessId)
}

async function persistRun(root: string, run: HarnessRun): Promise<void> {
  const folder = historyDir(root, run.harnessId)
  await atomicWriteFile(join(folder, `${run.id}.json`), `${JSON.stringify(run, null, 2)}\n`)
  const entries = await Promise.all((await fs.readdir(folder, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map(async (entry) => ({ name: entry.name, mtimeMs: (await fs.stat(join(folder, entry.name))).mtimeMs })))
  for (const entry of entries.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(50)) {
    await fs.rm(join(folder, entry.name), { force: true })
  }
}

async function queueModel<T>(key: string, limit: number, task: () => Promise<T>): Promise<T> {
  const queue = modelQueues.get(key) ?? { active: 0, waiting: [] }
  modelQueues.set(key, queue)
  if (queue.active >= limit) await new Promise<void>((resolve) => queue.waiting.push(resolve))
  queue.active += 1
  try {
    return await task()
  } finally {
    queue.active -= 1
    queue.waiting.shift()?.()
    if (queue.active === 0 && queue.waiting.length === 0) modelQueues.delete(key)
  }
}

function retryable(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase()
  if (/auth|unauthori|forbidden|invalid.?request|quota|billing|credit/.test(message)) return false
  return /\b408\b|\b429\b|\b5\d\d\b|timeout|timed out|network|socket|econn|fetch failed|temporar/.test(message)
}

function retryAfter(error: unknown): number | null {
  const message = String(error instanceof Error ? error.message : error)
  const seconds = message.match(/retry[- ]after[:= ]+(\d+(?:\.\d+)?)/i)
  if (seconds) return Math.max(0, Number(seconds[1]) * 1000)
  const date = message.match(/retry[- ]after[:= ]+([^.]*(?:GMT|UTC))/i)
  if (!date) return null
  const at = Date.parse(date[1])
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}

interface CancellationState {
  readonly aborted: boolean
  removeEventListener(type: 'abort', listener: () => void): void
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
}

const cancellationOf = (controller: AbortController): CancellationState =>
  controller.signal

function delay(ms: number, cancellation: CancellationState): Promise<void> {
  return new Promise((resolve, reject) => {
    if (cancellation.aborted) { reject(new Error(t('assistant.backend.harnessCancelled'))); return }
    const abort = (): void => { clearTimeout(timer); reject(new Error(t('assistant.backend.harnessCancelled'))) }
    const timer = setTimeout(() => { cancellation.removeEventListener('abort', abort); resolve() }, ms)
    cancellation.addEventListener('abort', abort, { once: true })
  })
}

interface CaseMeter {
  latencyMs: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  retries: number
  cacheHits: number
  turnCount: number
}

async function completion(
  root: string,
  run: HarnessRun,
  target: HarnessTarget,
  caseId: string,
  turn: number,
  request: HarnessCompletionRequest,
  settings: Record<string, string | number | boolean | readonly string[]>,
  meter: CaseMeter,
  cancellation: CancellationState
): Promise<HarnessCompletion> {
  const harness = getLoadedHarness(run.harnessId)
  if (!harness) throw new Error(t('assistant.backend.harnessUnloaded'))
  const connection = (await listConnections(root)).find(connection => target.connectionId ? connection.id === target.connectionId && connection.provider === target.provider : connection.provider === target.provider)
  if (!connection) throw new Error('Selected AI connection is unavailable')
  const providerDigest = 'core-ai-v1'
  const key = harnessCacheKey({
    harnessDigest: harness.digest,
    caseId,
    turn,
    providerDigest,
    provider: target.provider,
    connectionId: connection.id,
    model: target.model,
    baseUrl: connection.baseUrl,
    request,
    settings
  })
  if (run.options.useCache) {
    const cached = await readHarnessCache(harness.manifest.id, key, harness.config.cache.maxAgeDays)
    if (cached) {
      meter.cacheHits += 1
      meter.turnCount += 1
      return cached
    }
  }
  let lastError: unknown
  let attempts = 0
  for (let attempt = 1; attempt <= harness.config.retry.maxAttempts; attempt += 1) {
    attempts = attempt
    if (cancellation.aborted) throw new Error(t('assistant.backend.harnessCancelled'))
    try {
      const controller = new AbortController()
      cancellation.addEventListener('abort', () => controller.abort(), { once: true })
      const modelKey = `${connection.id}:${target.model}`
      const cooldown = (modelCooldownUntil.get(modelKey) ?? 0) - Date.now()
      if (cooldown > 0) await delay(cooldown, cancellation)
      const value = await queueModel(modelKey, run.options.concurrency, () => runDetailed(root, {
        requestId: `${run.id}:${caseId}:${turn}:${attempt}`,
        provider: target.provider,
        connectionId: target.connectionId,
        model: target.model,
        messages: request.messages,
        tools: request.tools,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        origin: 'harness'
      }, controller))
      modelCooldownUntil.delete(modelKey)
      const result: HarnessCompletion = {
        text: value.text,
        toolCalls: value.toolCalls,
        events: value.events,
        usage: { inputTokens: value.inputTokens, outputTokens: value.outputTokens },
        finishReason: value.finishReason,
        latencyMs: value.latencyMs,
        cached: false,
        retries: attempt - 1
      }
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > harness.config.execution.maxResponseBytes) throw new Error(t('assistant.backend.harnessResponseSize'))
      meter.latencyMs += value.latencyMs
      meter.inputTokens += value.inputTokens
      meter.outputTokens += value.outputTokens
      meter.costUsd += costFor(target.provider, target.model, value.inputTokens, value.outputTokens)
      meter.retries += attempt - 1
      meter.turnCount += 1
      if (run.options.useCache) await writeHarnessCache(harness.manifest.id, key, result, harness.config.cache.maxAgeDays, harness.config.cache.maxSizeMb)
      return result
    } catch (error) {
      lastError = error
      if (attempt >= harness.config.retry.maxAttempts || !retryable(error)) break
      const retryMs = retryAfter(error)
      const ceiling = Math.min(harness.config.retry.maxDelayMs, harness.config.retry.baseDelayMs * 2 ** (attempt - 1))
      const waitMs = retryMs ?? Math.floor(Math.random() * Math.max(1, ceiling))
      if (/\b429\b|rate.?limit/i.test(String(error instanceof Error ? error.message : error))) {
        modelCooldownUntil.set(`${connection.id}:${target.model}`, Date.now() + waitMs)
      }
      emit({ runId: run.id, harnessId: run.harnessId, type: 'retry', target, caseId, attempt: attempt + 1, delayMs: waitMs })
      await delay(waitMs, cancellation)
    }
  }
  const message = redactSecrets(lastError instanceof Error ? lastError.message : String(lastError))
  const wrapped = new Error(message) as Error & { kind?: string }
  wrapped.kind = retryable(lastError) ? 'network_error' : 'completion_error'
  ;(wrapped as Error & { attempts?: number }).attempts = attempts
  throw wrapped
}

function runCaseWorker(
  root: string,
  run: HarnessRun,
  target: HarnessTarget,
  caseDefinition: { id: string; name: string; description?: string; weight: number },
  settings: Record<string, string | number | boolean | readonly string[]>,
  cancellation: CancellationState
): Promise<HarnessCaseRun> {
  const harness = getLoadedHarness(run.harnessId)!
  const meter: CaseMeter = { latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, retries: 0, cacheHits: 0, turnCount: 0 }
  return new Promise((resolveCase) => {
    const worker = createHarnessWorker({
      mode: 'run', url: harness.url, harnessId: harness.manifest.id,
      caseId: caseDefinition.id, target, settings, maxTurns: harness.config.execution.maxTurns
    })
    let settled = false
    let caseReady = false
    let requestedTurns = 0
    let pendingCalls = 0
    const requests = new Set<string>()
    const caseCancellation = new AbortController()
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => finishError('timeout', t('assistant.backend.harnessCpu')), harness.config.execution.timeoutMs)
    }
    const pause = () => { if (watchdog) clearTimeout(watchdog); watchdog = undefined }
    const finish = (result: HarnessCaseResult) => {
      if (settled) return
      settled = true
      caseCancellation.abort()
      cancellation.removeEventListener('abort', cancelled)
      pause()
      void worker.terminate()
      resolveCase({
        id: caseDefinition.id,
        name: caseDefinition.name,
        weight: caseDefinition.weight,
        status: result.status,
        score: result.score ?? (result.status === 'pass' ? 1 : 0),
        assertions: result.assertions ?? [],
        metrics: result.metrics ?? {},
        ...(result.error ? { error: result.error } : {}),
        hostMetrics: meter
      })
    }
    const finishError = (kind: string, message: string, attempts?: number) => finish({ status: 'error', score: 0, assertions: [], metrics: {}, error: { kind, message: redactSecrets(message), ...(attempts ? { attempts } : {}) } })
    const cancelled = (): void => finishError('cancelled', t('assistant.backend.harnessCancelled'))
    cancellation.addEventListener('abort', cancelled, { once: true })
    worker.addEventListener('message', async ({ data: message }: MessageEvent<{ type?: string; id?: string; method?: string; payload?: { caseId?: string; turn?: number; request?: HarnessCompletionRequest }; result?: HarnessCaseResult; error?: string; kind?: string; attempts?: number }>) => {
      if (settled) return
      try {
        if (!message || typeof message !== 'object' || new TextEncoder().encode(JSON.stringify(message)).byteLength > harness.config.execution.maxResponseBytes) throw new Error(t('assistant.backend.harnessMessageSize'))
      } catch (error) { finishError('harness_error', String(error)); return }
      if (message.type === 'case-ready' && !caseReady) { caseReady = true; arm() }
      else if (message.type === 'host-call' && message.id) {
        if (typeof message.id !== 'string' || message.id.length > 64 || requests.has(message.id) || requests.size >= harness.config.execution.maxTurns + 4) { finishError('harness_error', 'Harness request exceeds its operation limit'); return }
        requests.add(message.id)
        pendingCalls++
        pause()
        try {
          const request = message.payload?.request
          let value: unknown
          if (message.method === 'complete') {
            if (!request || message.payload?.caseId !== caseDefinition.id || message.payload.turn !== ++requestedTurns || requestedTurns > harness.config.execution.maxTurns) throw new Error(t('assistant.backend.harnessRequest'))
            value = await completion(root, run, target, caseDefinition.id, requestedTurns, request, settings, meter, caseCancellation.signal)
          } else if (message.method === 'clear-cache') {
            value = await clearHarnessCache(run.harnessId)
          } else {
            throw new Error(t('assistant.backend.harnessOperation'))
          }
          if (!settled) worker.postMessage({ type: 'host-result', id: message.id, value })
        } catch (error) {
          const typed = error as Error & { kind?: string; attempts?: number }
          if (!settled) worker.postMessage({ type: 'host-result', id: message.id, error: { message: error instanceof Error ? error.message : String(error), kind: typed.kind, attempts: typed.attempts } })
        } finally {
          pendingCalls--
          if (!settled && !pendingCalls) arm()
        }
      } else if (message.type === 'case-result' && message.result) {
        try { finish(normalizeHarnessResult(message.result)) } catch (error) { finishError('harness_error', String(error)) }
      }
      else if (message.type === 'worker-error') finishError(message.kind ?? 'harness_error', message.error ?? t('assistant.backend.harnessWorker'), message.attempts)
    })
    worker.addEventListener('error', (error) => finishError('worker_error', error.message))
    arm()
    if (cancellation.aborted) cancelled()
  })
}

async function runTarget(
  root: string,
  run: HarnessRun,
  target: HarnessTarget,
  concurrency: number,
  settings: Record<string, string | number | boolean | readonly string[]>,
  cancellation: CancellationState
): Promise<HarnessTargetRun> {
  const harness = getLoadedHarness(run.harnessId)!
  emit({ runId: run.id, harnessId: run.harnessId, type: 'target-started', target })
  const cases = new Array<HarnessCaseRun>(harness.cases.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, harness.cases.length) }, async () => {
    while (!cancellation.aborted) {
      const index = cursor++
      if (index >= harness.cases.length) return
      const definition = harness.cases[index]
      emit({ runId: run.id, harnessId: run.harnessId, type: 'case-started', target, caseId: definition.id })
      cases[index] = await runCaseWorker(root, run, target, definition, settings, cancellation)
      emit({ runId: run.id, harnessId: run.harnessId, type: 'case-completed', target, caseId: definition.id })
    }
  }))
  const completed = cases.filter(Boolean)
  const scored = completed.filter((item) => item.status !== 'skip')
  const weight = scored.reduce((sum, item) => sum + item.weight, 0)
  const result = { target, score: weight ? scored.reduce((sum, item) => sum + item.score * item.weight, 0) / weight : 0, cases: completed }
  emit({ runId: run.id, harnessId: run.harnessId, type: 'target-completed', target })
  return result
}

export async function startHarnessRun(
  root: string,
  harnessId: string,
  targets: HarnessTarget[],
  options: HarnessRunOptions = {}
): Promise<HarnessRun> {
  const owner = backendApi()
  if (backendClosing(owner) || activeRuns.size >= 4) throw new Error('Assistant harness admission is unavailable')
  await ensureHarnessPackages(root)
  if (backendClosing(owner) || backendApi() !== owner || activeRuns.size >= 4) throw new Error('Assistant backend changed during harness admission')
  const harness = getLoadedHarness(harnessId)
  if (!harness) throw new Error(t('assistant.backend.harnessUnavailable'))
  if (targets.length === 0) throw new Error(t('assistant.backend.harnessTargets'))
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, harness.config.execution.maxConcurrency))
  const run: HarnessRun = {
    id: crypto.randomUUID(),
    harnessId,
    harnessVersion: harness.manifest.version,
    sourceDigest: harness.digest,
    startedAt: Date.now(),
    status: 'running',
    options: { useCache: options.useCache ?? false, concurrency },
    targets: []
  }
  const controller = new AbortController()
  activeRuns.set(run.id, controller)
  try { await persistRun(root, run) } catch (error) { activeRuns.delete(run.id); throw error }
  if (controller.signal.aborted || backendClosing(owner) || backendApi() !== owner) {
    activeRuns.delete(run.id)
    run.status = 'cancelled'; run.completedAt = Date.now()
    if (backendApi() === owner) await persistRun(root, run)
    return structuredClone(run)
  }
  emit({ runId: run.id, harnessId, type: 'started', run })
  const status = listHarnessPackageStatuses().find((item) => item.id === harnessId)
  void withBackgroundOperation(root, async () => {
    try {
      for (const target of targets) {
        const cancellation = cancellationOf(controller)
        if (cancellation.aborted) break
        run.targets.push(await runTarget(root, run, target, concurrency, status?.settings ?? {}, cancellation))
      }
      run.status = cancellationOf(controller).aborted ? 'cancelled' : 'completed'
    } catch (error) {
      run.status = cancellationOf(controller).aborted ? 'cancelled' : 'error'
      run.error = redactSecrets(error instanceof Error ? error.message : String(error))
    } finally {
      run.completedAt = Date.now()
      activeRuns.delete(run.id)
      await persistRun(root, run)
      emit({ runId: run.id, harnessId, type: run.status === 'cancelled' ? 'cancelled' : run.status === 'error' ? 'error' : 'completed', run, message: run.error })
    }
  })
  return structuredClone(run)
}

export function cancelHarnessRun(runId: string): boolean {
  const controller = activeRuns.get(runId)
  if (!controller) return false
  controller.abort()
  return true
}

export const harnessRunActive = (runId: string): boolean => activeRuns.has(runId)
export function cancelAllHarnessRuns(): void { for (const controller of activeRuns.values()) controller.abort() }

export async function listHarnessRuns(root: string, harnessId: string, limit = 50): Promise<HarnessRun[]> {
  const folder = historyDir(root, harnessId)
  const entries = await Promise.all((await fs.readdir(folder, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map(async (entry) => {
      try { return JSON.parse(await fs.readFile(join(folder, entry.name), 'utf8')) as HarnessRun } catch { return null }
    }))
  return entries.filter((entry): entry is HarnessRun => Boolean(entry)).sort((a, b) => b.startedAt - a.startedAt).slice(0, Math.min(50, Math.max(1, limit)))
}

export async function readHarnessRun(root: string, runId: string): Promise<HarnessRun | null> {
  if (!/^[a-f0-9-]{20,50}$/i.test(runId)) return null
  const base = join(root, ASSISTANT_HARNESS_RUNS_DIR)
  for (const harness of await fs.readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!harness.isDirectory()) continue
    try { return JSON.parse(await fs.readFile(join(base, harness.name, `${runId}.json`), 'utf8')) as HarnessRun } catch {}
  }
  return null
}
