import type { RunControls } from './coordinator'
import type { TurnSubmission } from '../../contracts/execution'

export function isSimpleLocalAction(turn: TurnSubmission | undefined, planning: boolean): boolean {
  if (!turn || planning || turn.attachments?.length || turn.callbackData) return false
  const text = turn.text.trim()
  if (text.length > 240 || /[\n\r;`]|\b(?:then|and|after|before|plan|research|implement|code|script|terminal|command|explain|quote|example|if|while|until)\b/i.test(text)) return false
  return /^(?:please\s+)?(?:open|close|show|read|list|find|search|create|write|append|rename|move|copy|delete|remove)\s+[^\s].*$/i.test(text) && /\b(?:file|folder|note|vault|tab|view|plugin|app)\b|\S+\.[a-z\d]{1,8}\b/i.test(text)
}

export interface TurnProgress {
  /** A forward transition: names the stage and starts its own no-progress deadline. */
  stage(name: string, timeoutMs?: number): void
  /** Useful provider or tool output: extends the current stage's deadline. */
  advance(): void
  /** Names the stage without extending the deadline: rediscovery and repeated identical failures are not progress.
   *  A longer provider wait is cut back to 10 s. */
  hold(name: string): void
  /** An accepted effect whose outcome is not known yet; named in the expiry message so it is reconciled, never replayed. */
  uncertain(note?: string): void
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

// The deadline is monotonic and rechecked on every step, so work that stalled the event loop past it ends the turn
// instead of re-arming a fresh timer; the timer alone only covers waits where nothing runs.
export async function runResponsiveTurn(controls: RunControls, work: (controls: RunControls, progress: TurnProgress) => Promise<void>): Promise<void> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined, stage = 'preparing the conversation', timeout = 10000, deadline = 0, armedAt = 0, finished = false, pending: string | undefined
  // A provider wait longer than 10 s keeps a 10 s marker, so a repeat within it is cut back to the host limit.
  let short: ReturnType<typeof setTimeout> | undefined, shortElapsed = false, capped = false
  let reject!: (error: Error) => void
  const interrupted = new Promise<never>((_resolve, fail) => { reject = fail })
  const stop = (error: Error) => { if (finished || controller.signal.aborted) return; controller.abort(error); reject(error) }
  const expire = () => stop(Object.assign(new Error(`No progress while ${stage} for ${timeout / 1000} seconds. The turn stopped. ${pending ? `${pending} It is not retried automatically.` : 'Check any pending operation before retrying.'}`), { code: 'TURN_NO_PROGRESS' }))
  const overdue = () => timeout > 0 && performance.now() >= deadline
  const arm = () => {
    armedAt = performance.now(); deadline = armedAt + timeout; clearTimeout(timer); clearTimeout(short); shortElapsed = false; capped = false
    if (!finished && !controller.signal.aborted && timeout) timer = setTimeout(expire, timeout)
    if (!finished && !controller.signal.aborted && timeout > 10000) short = setTimeout(() => { shortElapsed = true; if (capped) expire() }, 10000)
  }
  const abort = () => stop(new Error('Conversation cancelled'))
  controls.signal.addEventListener('abort', abort, { once: true })
  const current = () => {
    if (!finished && !controller.signal.aborted && overdue()) expire()
    if (finished || controller.signal.aborted) throw controller.signal.reason ?? new Error('Conversation turn ended')
  }
  const guarded: RunControls = {
    ...controls, signal: controller.signal,
    state: async (state, tool) => { current(); await controls.state(state, tool) },
    message: async message => { current(); await controls.message(message) },
    stream: async text => { current(); await controls.stream(text) },
    context: async usage => { current(); await controls.context(usage) },
    update: async change => { current(); await controls.update(thread => { current(); change(thread) }) }
  }
  const progress: TurnProgress = {
    stage: (name, timeoutMs) => { current(); stage = name; timeout = timeoutMs ?? 10000; arm() },
    advance: () => { if (finished || controller.signal.aborted) return; if (overdue()) expire(); else arm() },
    hold: name => {
      current(); stage = name
      if (!timeout) { timeout = 10000; arm() }
      else if (timeout > 10000) {
        // A provider that took longer than 10 s to answer gets 10 s from its answer, otherwise 10 s from the request.
        timeout = 10000
        if (shortElapsed) arm()
        else { capped = true; clearTimeout(timer); deadline = armedAt + timeout }
      }
    },
    uncertain: note => { pending = note }
  }
  if (controls.signal.aborted) abort()
  arm()
  try { await Promise.race([Promise.resolve().then(() => { current(); return work(guarded, progress) }), interrupted]) }
  finally { finished = true; clearTimeout(timer); clearTimeout(short); controls.signal.removeEventListener('abort', abort) }
}
