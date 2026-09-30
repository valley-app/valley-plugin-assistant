import { t } from '../runtime'
export const HARNESS_WORKER_SOURCE = String.raw`
let workerData
const parentPort = { postMessage: message => self.postMessage(message) }

const pending = new Map()
let rpcSequence = 0

function hostCall(method, payload) {
  const id = String(++rpcSequence)
  parentPort.postMessage({ type: 'host-call', id, method, payload })
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

addEventListener('message', ({data: message}) => {
  if (message?.type !== 'host-result') return
  const item = pending.get(message.id)
  if (!item) return
  pending.delete(message.id)
  if (message.error) {
    const error = new Error(message.error.message ?? String(message.error))
    error.kind = message.error.kind
    error.attempts = message.error.attempts
    item.reject(error)
  }
  else item.resolve(message.value)
})

function fail(key, params = {}) {
  const text = workerData.messages?.[key] ?? key
  throw new Error(text.replace(/\{\{(\w+)\}\}/g, (_, name) => String(params[name] ?? '')))
}

async function registration() {
  const exported = await import(workerData.url)
  if (typeof exported.register !== 'function') fail('assistant.backend.harnessExport')
  const api = Object.freeze({ case: Object.freeze((definition) => definition) })
  const registered = exported.register(api)
  if (!registered || registered.id !== workerData.harnessId || !Array.isArray(registered.cases)) {
    fail('assistant.backend.harnessRegistration')
  }
  const seen = new Set()
  for (const item of registered.cases) {
    if (!item || typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.id) || typeof item.name !== 'string' || !item.name || typeof item.run !== 'function') {
      fail('assistant.backend.harnessCaseFields')
    }
    if (item.weight !== undefined && (!Number.isFinite(item.weight) || item.weight <= 0)) fail('assistant.backend.harnessWeight')
    if (seen.has(item.id)) fail('assistant.backend.harnessUnique')
    seen.add(item.id)
  }
  return registered
}

function normalizeResult(value) {
  if (!value || !['pass', 'fail', 'skip', 'error'].includes(value.status)) fail('assistant.backend.caseStatus')
  const fallback = value.status === 'pass' ? 1 : 0
  const score = value.score === undefined ? fallback : value.score
  if (!Number.isFinite(score) || score < 0 || score > 1) fail('assistant.backend.caseScore')
  const assertions = value.assertions ?? []
  if (!Array.isArray(assertions) || assertions.some((item) => !item || typeof item.name !== 'string' || typeof item.passed !== 'boolean' || (item.message !== undefined && typeof item.message !== 'string'))) {
    fail('assistant.backend.caseAssertions')
  }
  const metrics = value.metrics ?? {}
  if (!metrics || typeof metrics !== 'object' || Object.entries(metrics).some(([key, item]) => !/^[a-z][a-z0-9_.-]{0,63}$/.test(key) || !Number.isFinite(item))) {
    fail('assistant.backend.caseMetrics')
  }
  const error = value.error
  if (error !== undefined && (!error || typeof error.kind !== 'string' || !error.kind || typeof error.message !== 'string' || (error.attempts !== undefined && (!Number.isInteger(error.attempts) || error.attempts < 1)))) {
    fail('assistant.backend.caseError')
  }
  return { status: value.status, score, assertions, metrics, ...(error ? { error: { kind: error.kind, message: error.message, ...(error.attempts ? { attempts: error.attempts } : {}) } } : {}) }
}

function caseContext() {
  let turns = 0
  const complete = async (request) => {
    turns += 1
    if (turns > workerData.maxTurns) fail('assistant.backend.harnessTurns')
    return hostCall('complete', { caseId: workerData.caseId, turn: turns, request })
  }
  const createThread = (input) => {
    const messages = [...(input.messages ?? [])]
    const calls = []
    let stopped = false
    const tools = [...(input.tools ?? [])]
    const definitions = tools.map((item) => item.definition ?? item)
    return Object.freeze({
      async run() {
        if (stopped) fail('assistant.backend.harnessHalted')
        let response
        do {
          response = await complete({ ...input, messages: [...messages], tools: definitions })
          const assistant = { role: 'assistant', content: response.text, ...(response.toolCalls.length ? { toolCalls: response.toolCalls } : {}) }
          messages.push(assistant)
          calls.push(...response.toolCalls)
          stopped = response.toolCalls.length === 0 || !input.autoTools
          if (!stopped) {
            for (const call of response.toolCalls) {
              const tool = tools.find((item) => (item.definition ?? item).name === call.name)
              if (!tool || typeof tool.handle !== 'function') fail('assistant.backend.harnessHandler', { value: call.name })
              const result = await tool.handle({ call, transcript: [...messages], settings: workerData.settings })
              messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(result) })
            }
          }
        } while (!stopped)
        return response
      },
      appendMessage(message) { messages.push(message); stopped = false },
      appendToolResult(callId, result, name) {
        messages.push({ role: 'tool', toolCallId: callId, ...(name ? { name } : {}), content: JSON.stringify(result) })
        stopped = false
      },
      transcript() { return Object.freeze([...messages]) },
      toolCalls() { return Object.freeze([...calls]) },
      halted() { return stopped }
    })
  }
  return Object.freeze({
    target: Object.freeze({ ...workerData.target }),
    settings: Object.freeze({ ...workerData.settings }),
    cancellation: Object.freeze({
      get aborted() { return false },
      throwIfAborted() {}
    }),
    complete,
    createThread,
    cache: Object.freeze({ clear: () => hostCall('clear-cache', {}) })
  })
}

addEventListener('message', async ({data: message}) => {
  if (message?.type !== 'initialize' || workerData) return
  workerData = message.data
  try {
    const registered = await registration()
    if (workerData.mode === 'validate') {
      parentPort.postMessage({ type: 'validated', cases: registered.cases.map((item) => ({ id: item.id, name: item.name, description: item.description, weight: item.weight ?? 1 })) })
      return
    }
    const item = registered.cases.find((entry) => entry.id === workerData.caseId)
    if (!item) fail('assistant.backend.harnessCaseUnknown', { value: workerData.caseId })
    parentPort.postMessage({ type: 'case-ready' })
    const result = normalizeResult(await item.run(caseContext()))
    parentPort.postMessage({ type: 'case-result', result, turns: rpcSequence })
  } catch (error) {
    parentPort.postMessage({
      type: 'worker-error',
      error: error instanceof Error ? error.message : String(error),
      kind: error?.kind,
      attempts: error?.attempts
    })
  }
})
`


export function createHarnessWorker(data: Record<string, unknown>): Worker {
  const url = URL.createObjectURL(new Blob([HARNESS_WORKER_SOURCE], { type: 'text/javascript' }))
  const worker = new Worker(url, { type: 'module', name: 'assistant-harness' })
  URL.revokeObjectURL(url)
  worker.postMessage({ type: 'initialize', data: { ...data, messages: harnessWorkerMessages() } })
  return worker
}
import type { HarnessCaseResult } from '../../harnessTypes'

export function normalizeHarnessResult(value: unknown): HarnessCaseResult {
  if (!value || typeof value !== 'object') throw new Error(t('assistant.backend.harnessResult'))
  const result = value as Record<string, unknown>
  if (!['pass', 'fail', 'skip', 'error'].includes(String(result.status))) throw new Error(t('assistant.backend.harnessStatus'))
  const score = result.score ?? (result.status === 'pass' ? 1 : 0)
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) throw new Error(t('assistant.backend.harnessScore'))
  const assertions = result.assertions ?? []
  if (!Array.isArray(assertions) || assertions.length > 1000 || assertions.some((item) => !item || typeof item.name !== 'string' || typeof item.passed !== 'boolean' || item.message !== undefined && typeof item.message !== 'string')) throw new Error(t('assistant.backend.harnessAssertions'))
  const metrics = result.metrics ?? {}
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics) || Object.entries(metrics).some(([key, value]) => !/^[a-z][a-z0-9_.-]{0,63}$/.test(key) || typeof value !== 'number' || !Number.isFinite(value))) throw new Error(t('assistant.backend.harnessMetrics'))
  const error = result.error as { kind?: unknown; message?: unknown; attempts?: unknown } | undefined
  if (error !== undefined && (!error || typeof error.kind !== 'string' || !error.kind || typeof error.message !== 'string' || error.attempts !== undefined && (typeof error.attempts !== 'number' || !Number.isInteger(error.attempts) || error.attempts < 1))) throw new Error(t('assistant.backend.harnessError'))
  return { status: result.status, score, assertions, metrics, ...(error ? { error } : {}) } as HarnessCaseResult
}

export function harnessWorkerMessages(): Record<string, string> {
  return Object.fromEntries(["assistant.backend.caseAssertions", "assistant.backend.caseError", "assistant.backend.caseMetrics", "assistant.backend.caseScore", "assistant.backend.caseStatus", "assistant.backend.harnessCaseFields", "assistant.backend.harnessCaseUnknown", "assistant.backend.harnessExport", "assistant.backend.harnessHalted", "assistant.backend.harnessHandler", "assistant.backend.harnessRegistration", "assistant.backend.harnessTurns", "assistant.backend.harnessUnique", "assistant.backend.harnessWeight"].map((key) => [key, t(key)]))
}
