import type { RunControls } from './coordinator'
import type { TurnSubmission } from '../../contracts/execution'

export function isSimpleLocalAction(turn: TurnSubmission | undefined, planning: boolean): boolean {
  if (!turn || planning || turn.attachments?.length || turn.callbackData) return false
  const text = turn.text.trim()
  if (text.length > 240 || /[\n\r;`]|\b(?:then|and|after|before|plan|research|implement|code|script|terminal|command|explain|quote|example|if|while|until)\b/i.test(text)) return false
  return /^(?:please\s+)?(?:open|close|show|read|list|find|search|create|write|append|rename|move|copy|delete|remove)\s+[^\s].*$/i.test(text) && /\b(?:file|folder|note|vault|tab|view|plugin|app)\b|\S+\.[a-z\d]{1,8}\b/i.test(text)
}

export interface TurnProgress {
  stage(name: string, timeoutMs?: number): void
  advance(): void
}

export interface TurnAdmission {
  check(): void
  step<T>(stage: string, work: () => Promise<T>): Promise<T>
}

export async function admitTurn<T>(work: (admission: TurnAdmission) => Promise<T>, signal?: AbortSignal): Promise<T> {
  let finished = false, failure: Error | undefined, timer: ReturnType<typeof setTimeout> | undefined, deadline = 0, stage = 'initializing the conversation'
  let reject!: (error: Error) => void
  const stopped = new Promise<never>((_resolve, fail) => { reject = fail })
  const stop = (error: Error) => { if (finished || failure) return; failure = error; reject(error) }
  const expired = () => Object.assign(new Error(`No progress while ${stage} for 10 seconds. Admission stopped; check this conversation before sending the instruction again.`), { code: 'ADMISSION_TIMEOUT' })
  const check = () => { if (!finished && !failure && performance.now() >= deadline) stop(expired()); if (failure || finished) throw failure ?? new Error('Conversation admission ended') }
  const arm = (name: string) => {
    clearTimeout(timer)
    stage = name; deadline = performance.now() + 10000
    timer = setTimeout(() => stop(expired()), 10000)
  }
  const abort = () => stop(new Error('Conversation admission cancelled'))
  signal?.addEventListener('abort', abort, { once: true })
  const admission: TurnAdmission = { check, step: async (stage, task) => { check(); arm(stage); const result = await task(); check(); return result } }
  arm('initializing the conversation')
  if (signal?.aborted) abort()
  try { return await Promise.race([Promise.resolve().then(() => { check(); return work(admission) }), stopped]) }
  finally { finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

export async function runResponsiveTurn(controls: RunControls, work: (controls: RunControls, progress: TurnProgress) => Promise<void>): Promise<void> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined, stage = 'preparing the conversation', timeout = 10000, finished = false
  let reject!: (error: Error) => void
  const interrupted = new Promise<never>((_resolve, fail) => { reject = fail })
  const stop = (error: Error) => { if (finished) return; controller.abort(error); reject(error) }
  const arm = () => {
    clearTimeout(timer)
    if (!finished && !controller.signal.aborted && timeout) timer = setTimeout(() => stop(new Error(`No progress while ${stage} for ${timeout / 1000} seconds. The turn stopped. Check any pending operation before retrying.`)), timeout)
  }
  const abort = () => stop(new Error('Conversation cancelled'))
  controls.signal.addEventListener('abort', abort, { once: true })
  const current = () => { if (finished || controller.signal.aborted) throw controller.signal.reason ?? new Error('Conversation turn ended') }
  const guarded: RunControls = {
    ...controls, signal: controller.signal,
    state: async state => { current(); await controls.state(state) },
    message: async message => { current(); await controls.message(message) },
    stream: async text => { current(); await controls.stream(text) },
    context: async usage => { current(); await controls.context(usage) },
    update: async change => { current(); await controls.update(thread => { current(); change(thread) }) }
  }
  const progress: TurnProgress = {
    stage: (name, timeoutMs) => { current(); stage = name; timeout = timeoutMs ?? 10000; arm() },
    advance: () => { if (!finished && !controller.signal.aborted) arm() }
  }
  if (controls.signal.aborted) abort()
  arm()
  try { await Promise.race([Promise.resolve().then(() => { current(); return work(guarded, progress) }), interrupted]) }
  finally { finished = true; clearTimeout(timer); controls.signal.removeEventListener('abort', abort) }
}
