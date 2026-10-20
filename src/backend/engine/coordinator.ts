import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
type OwnerApi = PluginBackendOperationContext['api']
import type { AiChatThread, AiMessage } from '../../types'
import type { ContextUsage } from '../../contracts/context'
import type { QueuedTurn, SessionEvent, SessionSnapshot, SessionState, TurnSubmission } from '../../contracts/execution'
import { AssistantRepository, boundedQuery, record, type DurableRecord } from '../persistence/repositories'
import { assertTransition } from './stateMachine'
import { transportValue } from '../transport'
import { markChatStopping } from '../processScopes'
import type { TurnAdmission } from './responsiveness'
import { failureReply } from './replyShape'

export interface RunControls {
  api?: OwnerApi
  signal: AbortSignal
  shouldSteer(): boolean
  state(state: SessionState, tool?: string): Promise<void>
  message(message: AiMessage): Promise<void>
  stream(text: string): Promise<void>
  context(usage: ContextUsage): Promise<void>
  update(change: (thread: AiChatThread) => void): Promise<void>
}
export interface CoordinatorPorts {
  run(session: SessionSnapshot, turn: QueuedTurn | undefined, controls: RunControls): Promise<void>
  project(session: SessionSnapshot, restoring?: boolean, api?: OwnerApi): Promise<void>
  publish(session: SessionSnapshot, event: SessionEvent, api?: OwnerApi): void
}

class StalledSave extends Error {}

/** These tools only read the command catalog, so a stopped turn that ran nothing else still changed nothing. A stored
 *  tool result names its tool only through the call it answers, so `thread` resolves it by toolCallId. */
const catalogTools = new Set(['command_list', 'command_describe'])
type EffectMessage = Pick<AiMessage, 'role' | 'name' | 'toolCalls' | 'toolCallId'>
export const touchesEffects = (message: EffectMessage, thread: readonly EffectMessage[] = []): boolean => {
  if (message.role !== 'tool') return Boolean(message.toolCalls?.some(call => !catalogTools.has(call.name)))
  const name = message.name ?? thread.flatMap(item => item.toolCalls ?? []).find(call => call.id === message.toolCallId)?.name
  return !catalogTools.has(name ?? '')
}

function notApplied(reason: unknown): Error {
  const message = reason instanceof Error ? reason.message : 'Execution cancelled'
  return Object.assign(new Error(message, { cause: reason }), { name: 'AbortError', committed: false, outcome: 'not-applied', retryable: false })
}

export class SessionCoordinator {
  private turnResults = new Map<string, { snapshot: SessionSnapshot; error?: unknown; untouched?: boolean }>()
  private changed = new Set<() => void>()
  private notify(): void { for (const notify of this.changed) notify() }
  private turnOwners = new Map<string, OwnerApi>()
  private continuationOwners = new Map<string, OwnerApi>()
  private scoped(api?: OwnerApi): AssistantRepository { return api ? new AssistantRepository(api.data) : this.repository }
  private sessions = new Map<string, SessionSnapshot>()
  private active = new Map<string, { controller: AbortController; steer: boolean; occupied: boolean; completed: boolean; task: Promise<void>; api?: OwnerApi }>()
  private capacityWaiters: Array<{ id: string; resume(): void }> = []
  private writes = new Map<string, Promise<unknown>>()
  // Only the ids: a second in-memory copy of every conversation outgrew the backend's memory.
  private committed = new Set<string>()
  // Settled conversations restored without their messages; the stored row keeps them until the conversation is used.
  private unloaded = new Set<string>()
  private closing = false
  private rejectedAdmissions = new Set<string>()

  constructor(private repository: AssistantRepository, private ports: CoordinatorPorts, private concurrency = 4, private saveTimeoutMs = 10000) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid conversation concurrency')
  }

  async restore(): Promise<void> {
    // Each row holds a whole conversation, so rows are read in small pages and a settled conversation keeps only its state;
    // holding every conversation (and rewriting every chat file) at startup ran the backend out of memory.
    let cursor: string | undefined
    do {
      const page = await boundedQuery(this.repository.data.dataset<DurableRecord>('sessions'), { where: {}, cursor, limit: 20 })
      cursor = page.cursor
      for (const row of page.rows) await this.restoreOne(row.payload as unknown as SessionSnapshot)
    } while (cursor)
  }

  private async restoreOne(session: SessionSnapshot): Promise<void> {
    if (await this.repository.get('conversation_deletions', session.conversationId)) return
    this.sessions.set(session.conversationId, session)
    this.committed.add(session.conversationId)
    for (const turn of [...session.queue]) if (turn.admissionPending) await this.rejectAdmission(turn, new Error('Message admission was interrupted before dispatch. Submit a new instruction.'))
    const held = session.queue.filter(turn => turn.admissionPending === false)
    for (const turn of held) turn.editing = true
    const recovering = !['IDLE', 'AWAITING_QUESTION', 'AWAITING_APPROVAL', 'FAILED', 'INTERRUPTED'].includes(session.state)
    if (recovering) {
      session.state = 'INTERRUPTED'; session.paused = true
      session.error = 'Execution was interrupted. Review pending work and choose Continue.'
    }
    if (recovering || held.length) await this.commit(session, 'recovered', {}, held.map(turn => ({ dataset: 'turn_queue', operation: 'upsert', values: record(turn.id, session.conversationId, 'PENDING', turn) })))
    // The transcript is projected once more (it may have missed its last write), then a settled conversation keeps only its state.
    await this.ports.project(session, true)
    if (session.thread && !recovering && !session.queue.length && !['telegram', 'whatsapp'].includes(session.thread.source ?? '')) { delete session.thread; this.unloaded.add(session.conversationId) }
  }

  // A conversation restored without its messages reads them from its stored row before any use or write.
  private async hydrate(session: SessionSnapshot, api?: OwnerApi): Promise<void> {
    const id = session.conversationId
    if (!this.unloaded.has(id)) return
    const stored = await this.scoped(api).get<SessionSnapshot>('sessions', id).catch(() => this.repository.get<SessionSnapshot>('sessions', id))
    if (!this.unloaded.has(id)) { session.thread ??= structuredClone(this.sessions.get(id)?.thread); return }
    if (!stored?.thread) throw new Error('Conversation is unavailable')
    session.thread = stored.thread
    const live = this.sessions.get(id)
    if (live && live !== session) live.thread = structuredClone(stored.thread)
    this.unloaded.delete(id)
  }

  // A settled conversation restored at startup has no messages here until load() or a change reads them.
  snapshot(id: string): SessionSnapshot | null { return transportValue(this.sessions.get(id) ?? null) }

  async load(id: string, api?: OwnerApi): Promise<SessionSnapshot | null> {
    const session = this.sessions.get(id)
    if (session) await this.hydrate(session, api)
    return this.snapshot(id)
  }

  async initialize(thread: AiChatThread, api?: OwnerApi): Promise<SessionSnapshot> {
    return this.serial(thread.id, async () => {
      const existing = this.sessions.get(thread.id)
      if (existing) { await this.hydrate(existing, api); return structuredClone(existing) }
      const session: SessionSnapshot = { conversationId: thread.id, revision: 0, state: 'IDLE', runId: null, streamingText: '', queue: [], paused: false, error: null, context: null, thread: structuredClone(thread) }
      this.sessions.set(thread.id, session)
      await this.commit(session, 'created', {}, [{ dataset: 'conversation_deletions', operation: 'delete', key: { id: thread.id } }], api)
      return structuredClone(session)
    })
  }

  async remove(id: string, api?: OwnerApi): Promise<void> {
    await this.stop(id, api)
    await this.active.get(id)?.task.catch(() => {})
    await this.serial(id, async () => {
      await this.scoped(api).data.transaction([{ dataset: 'conversation_deletions', operation: 'upsert', values: record(id, id, 'DELETED', { id, deletedAt: Date.now() }) }, { dataset: 'sessions', operation: 'delete', key: { id } }, { dataset: 'quiz_sessions', operation: 'delete', key: { id } }])
      for (const turn of this.sessions.get(id)?.queue ?? []) this.turnOwners.delete(turn.id)
      const current = this.sessions.get(id)?.currentTurn
      if (current) this.turnOwners.delete(current.id)
      this.continuationOwners.delete(id); this.committed.delete(id); this.unloaded.delete(id)
      this.sessions.delete(id)
    })
  }

  // Sealed test fixtures only (sealedTest.ts): drops an idle conversation's in-memory session and turn bookkeeping without recording a deletion.
  async forget(id: string): Promise<string[]> {
    return this.serial(id, async () => {
      if (this.active.has(id)) throw Object.assign(new Error('Conversation must be idle before it is forgotten'), { code: 'SESSION_ACTIVE', outcome: 'not-applied' })
      const session = this.sessions.get(id), turns = [...(session?.queue ?? []), ...(session?.currentTurn ? [session.currentTurn] : [])].map(turn => turn.id)
      for (const [turn, result] of this.turnResults) if (result.snapshot.conversationId === id) { this.turnResults.delete(turn); turns.push(turn) }
      for (const turn of turns) { this.turnOwners.delete(turn); this.rejectedAdmissions.delete(turn) }
      this.continuationOwners.delete(id); this.committed.delete(id); this.unloaded.delete(id); this.sessions.delete(id); this.notify()
      return [...new Set(turns)].sort()
    })
  }

  async change(id: string, operation: (thread: AiChatThread) => Promise<{ turn?: TurnSubmission; effects?: Parameters<AssistantRepository['commit']>[3] }>, api?: OwnerApi): Promise<void> {
    await this.serial(id, async () => {
      const session = this.sessions.get(id)
      if (session) await this.hydrate(session, api)
      if (!session?.thread || this.active.get(id) && !this.active.get(id)!.completed) throw new Error('Conversation must be idle before this action')
      const changed = structuredClone(session.thread)
      const { turn: input, effects = [] } = await operation(changed)
      session.thread = changed
      if (input) {
        const known = await this.scoped(api).get<QueuedTurn>('turn_queue', input.id)
        if (!known) {
          const turn: QueuedTurn = { ...input, attachments: input.attachments ?? [], createdAt: Date.now(), priority: 0, editing: false }
          session.queue.push(turn)
          effects.push({ dataset: 'turn_queue', operation: 'insert', values: record(turn.id, id, 'PENDING', turn) })
        }
        session.paused = false; session.state = 'QUEUED'; session.error = null
      }
      await this.commit(session, 'conversation.changed', {}, effects, api)
      if (input && api) this.turnOwners.set(input.id, api)
      await this.ports.project(session, false, api)
      this.schedule()
    })
  }

  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const task = (this.writes.get(id) ?? Promise.resolve()).catch(() => {}).then(operation)
    this.writes.set(id, task)
    void task.finally(() => { if (this.writes.get(id) === task) this.writes.delete(id) }).catch(() => {})
    return task
  }

  private async commit(session: SessionSnapshot, type: string, payload: unknown, effects: Parameters<AssistantRepository['commit']>[3] = [], api?: OwnerApi, publish = true): Promise<SessionEvent> {
    try {
      await this.hydrate(session, api)
      const event = await this.scoped(api).commit(session, type, payload, effects)
      this.committed.add(session.conversationId)
      if (publish) { this.ports.publish(transportValue(session), transportValue(event), api); this.notify() }
      return event
    } catch (error) {
      // A conversation that was committed before goes back to its stored row.
      const stored = (repository: AssistantRepository) => repository.get<SessionSnapshot>('sessions', session.conversationId)
      const previous = this.committed.has(session.conversationId) ? await stored(this.scoped(api)).catch(() => stored(this.repository)).catch(() => undefined) : null
      if (previous === undefined) throw error
      if (previous) {
        for (const key of Object.keys(session)) delete (session as unknown as Record<string, unknown>)[key]
        Object.assign(session, structuredClone(previous))
      } else this.sessions.delete(session.conversationId)
      throw error
    }
  }

  async enqueue(input: TurnSubmission, effects: Parameters<AssistantRepository['commit']>[3] = [], api?: OwnerApi): Promise<SessionSnapshot> {
    if (this.closing) throw new Error('Assistant is stopping')
    return this.serial(input.conversationId, async () => {
      let session = this.sessions.get(input.conversationId)
      const known = await this.scoped(api).get<QueuedTurn>('turn_queue', input.id)
      if (known) {
        if (known.conversationId !== input.conversationId) throw new Error('Submission identity belongs to another conversation')
        if (input.inputFingerprint && known.inputFingerprint !== input.inputFingerprint) throw new Error('Submission identity was reused with different content')
        if (!session) throw new Error('This message was processed before the conversation was removed')
        return structuredClone(session!)
      }
      if (!session) {
        if (!input.thread || input.thread.id !== input.conversationId) throw new Error('Conversation is required')
        session = { conversationId: input.conversationId, revision: 0, state: 'IDLE', runId: null, streamingText: '', queue: [], paused: false, error: null, context: null, thread: structuredClone(input.thread) }
        this.sessions.set(input.conversationId, session)
      }
      const turn: QueuedTurn = { admissionPending: input.admissionPending, targetReference: input.targetReference, targetFallback: input.targetFallback, inputFingerprint: input.inputFingerprint, questionId: input.questionId, callbackData: input.callbackData, channelActor: input.channelActor, origin: input.origin, id: input.id, conversationId: input.conversationId, text: input.text, attachments: input.attachments ?? [], createdAt: Date.now(), priority: 0, editing: false }
      session.queue.push(turn)
      if (session.state === 'IDLE') session.state = 'QUEUED'
      await this.commit(session, 'enqueued', turn, [{ dataset: 'conversation_deletions', operation: 'delete', key: { id: input.conversationId } }, { dataset: 'turn_queue', operation: 'insert', values: record(turn.id, turn.conversationId, 'PENDING', turn) }, ...turn.attachments.flatMap(attachment => attachment.id ? [{ dataset: 'attachment_refs', operation: 'upsert' as const, values: { attachmentId: attachment.id, chatId: input.conversationId } }] : []), ...effects], api)
      if (api) this.turnOwners.set(input.id, api)
      this.schedule()
      return structuredClone(session)
    })
  }

  async acceptAdmission(id: string, turnId: string, admission: TurnAdmission, api?: OwnerApi): Promise<SessionSnapshot> {
    return this.serial(id, async () => {
      admission.check()
      const session = this.sessions.get(id)
      if (!session) throw new Error('Conversation is unavailable')
      await this.hydrate(session, api)
      const candidate = structuredClone(session), turn = candidate.queue.find(value => value.id === turnId)
      if (!turn?.admissionPending) return structuredClone(session)
      turn.admissionPending = false
      const event = await this.commit(candidate, 'admission.accepted', { turnId }, [{ dataset: 'turn_queue', operation: 'upsert', values: record(turnId, id, 'PENDING', turn) }], api, false)
      admission.check()
      Object.assign(session, candidate)
      this.ports.publish(transportValue(session), transportValue(event), api); this.notify()
      this.schedule()
      return structuredClone(session)
    })
  }

  async rejectAdmission(input: TurnSubmission, error: unknown, api?: OwnerApi): Promise<void> {
    const id = input.conversationId, turnId = input.id
    this.rejectedAdmissions.add(turnId)
    await this.serial(id, async () => {
      const session = this.sessions.get(id), turn = session?.queue.find(value => value.id === turnId)
      if (!session || !turn?.admissionPending) {
        const known = await this.scoped(api).get<TurnSubmission>('turn_queue', turnId)
        if (!known) await this.scoped(api).data.transaction([{ dataset: 'turn_queue', operation: 'insert', values: record(turnId, id, 'REMOVED', { ...input, admissionPending: true }) }])
        else if (known.conversationId === id && known.admissionPending) await this.scoped(api).data.transaction([{ dataset: 'turn_queue', operation: 'upsert', values: record(turnId, id, 'REMOVED', known) }])
        return
      }
      session.queue = session.queue.filter(value => value.id !== turnId)
      if (!this.active.has(id) && !session.queue.length) { session.state = 'FAILED'; session.paused = true; session.error = String(error) }
      await this.commit(session, 'admission.rejected', { turnId }, [{ dataset: 'turn_queue', operation: 'upsert', values: record(turnId, id, 'REMOVED', turn) }], api)
      this.turnOwners.delete(turnId)
      this.schedule()
    }).catch(failure => {
      const session = this.sessions.get(id), turn = session?.queue.find(value => value.id === turnId)
      if (turn) { turn.admissionPending = true; turn.editing = true }
      if (session && !this.active.has(id)) { session.state = 'FAILED'; session.paused = true; session.error = String(error) }
      throw failure
    })
    this.rejectedAdmissions.delete(turnId)
  }

  async edit(id: string, turnId: string, patch: { text?: string; editing?: boolean; index?: number; remove?: boolean }, api?: OwnerApi): Promise<void> {
    await this.serial(id, async () => {
      const session = this.sessions.get(id), turn = session?.queue.find(turn => turn.id === turnId)
      if (!session || !turn) throw new Error('Queued message is no longer available')
      if (patch.text !== undefined) {
        if (!patch.text.trim() && !turn.attachments.length) throw new Error('Queued message is empty')
        turn.text = patch.text
      }
      if (patch.editing !== undefined) turn.editing = patch.editing
      if (patch.remove || patch.index !== undefined) session.queue = session.queue.filter(value => value.id !== turnId)
      if (patch.index !== undefined && !patch.remove) session.queue.splice(Math.max(0, Math.min(patch.index, session.queue.length)), 0, turn)
      await this.commit(session, 'queue.changed', { turnId }, [{ dataset: 'turn_queue', operation: 'upsert', values: record(turnId, id, patch.remove ? 'REMOVED' : 'PENDING', turn) }], api)
      if (patch.remove) this.turnOwners.delete(turnId)
      else if (api && !this.turnOwners.has(turnId)) this.turnOwners.set(turnId, api)
      this.schedule()
    })
  }

  async steer(id: string, turnId: string, api?: OwnerApi): Promise<void> {
    await this.edit(id, turnId, { index: 0, editing: false }, api)
    await this.serial(id, async () => {
      const session = this.sessions.get(id)!
      session.paused = false
      if (api && !this.turnOwners.has(turnId)) this.turnOwners.set(turnId, api)
      const active = this.active.get(id)
      if (active && !active.completed && !['FAILED', 'INTERRUPTED', 'IDLE'].includes(session.state)) {
        active.steer = true
        if (session.state === 'INFERRING' || session.state === 'PREPARING') active.controller.abort()
      } else {
        session.currentTurn = undefined
        session.error = null
        session.state = 'QUEUED'
      }
      await this.commit(session, 'steer.requested', { turnId }, [], api)
      this.schedule()
    })
  }

  async stop(id: string, api?: OwnerApi): Promise<void> {
    const done = markChatStopping(id)
    try {
      await this.bounded(this.serial(id, async () => {
        const session = this.sessions.get(id)
        if (!session) return
        session.paused = true
        await this.commit(session, 'stop.requested', {}, [], api)
        this.active.get(id)?.controller.abort()
        if (!this.active.has(id)) { session.state = 'INTERRUPTED'; await this.commit(session, 'interrupted', {}, [], api) }
      }), 'Saving is slow').catch(error => {
        if (!(error instanceof StalledSave)) throw error
        // A stalled save must not hold Stop: stop now, show it, and let the stop record follow the stalled write.
        const session = this.sessions.get(id)
        this.active.get(id)?.controller.abort()
        if (!session) return
        session.paused = true
        this.show(session, session.currentTurn ? { state: 'INTERRUPTED', streamingText: '', error: null } : {}, api)
      })
    } finally { done() }
  }

  async resume(id: string, api?: OwnerApi): Promise<void> {
    // A stopped run stays active until its final projection settles; resuming then must wait for it instead of being dropped as a no-op.
    const finishing = this.active.get(id)
    if (finishing && (finishing.completed || finishing.controller.signal.aborted)) await finishing.task.catch(() => {})
    await this.serial(id, async () => {
      const session = this.sessions.get(id)
      if (!session || this.active.has(id)) return
      session.paused = false; session.error = null; session.state = 'QUEUED'
      if (api) { this.continuationOwners.set(id, api); for (const turn of session.queue) this.turnOwners.set(turn.id, api); if (session.currentTurn) this.turnOwners.set(session.currentTurn.id, api) }
      await this.commit(session, 'continued', {}, [], api)
      this.schedule()
    })
  }

  // A durable write that stops answering must not hold the conversation: the caller gets a plain error after a bound while the write keeps its place in order.
  private bounded<T>(work: Promise<T>, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stall = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new StalledSave(message)), this.saveTimeoutMs) })
    void work.catch(() => {})
    return Promise.race([work, stall]).finally(() => clearTimeout(timer))
  }

  private show(session: SessionSnapshot, patch: Partial<SessionSnapshot>, api?: OwnerApi): void {
    const visible = { ...structuredClone(session), paused: true, ...patch }
    this.ports.publish(transportValue(visible), transportValue({ id: crypto.randomUUID(), conversationId: session.conversationId, revision: session.revision, type: 'save.stalled', payload: {}, createdAt: Date.now() } satisfies SessionEvent), api)
    this.notify()
  }

  private schedule(): void {
    if (this.closing) return
    const occupied = () => [...this.active.values()].filter(value => value.occupied).length
    while (this.capacityWaiters.length && occupied() < this.concurrency) {
      const waiting = this.capacityWaiters.shift()!, active = this.active.get(waiting.id)
      if (active && !active.controller.signal.aborted) { active.occupied = true; waiting.resume() }
    }
    for (const session of this.sessions.values()) {
      if (occupied() >= this.concurrency) break
      if (this.active.has(session.conversationId) || session.paused || session.state !== 'QUEUED' || session.queue[0]?.editing || session.queue[0]?.admissionPending || this.rejectedAdmissions.has(session.currentTurn?.id ?? session.queue[0]?.id ?? '')) continue
      const active = { controller: new AbortController(), steer: false, occupied: true, completed: false, untouched: false, task: Promise.resolve(), api: this.turnOwners.get(session.currentTurn?.id ?? session.queue[0]?.id ?? '') ?? this.continuationOwners.get(session.conversationId) }
      this.active.set(session.conversationId, active)
      active.task = this.execute(session, active)
      void active.task.catch(() => {})
    }
  }

  private async execute(session: SessionSnapshot, active: { controller: AbortController; steer: boolean; occupied: boolean; completed: boolean; untouched: boolean; api?: OwnerApi }): Promise<void> {
    const id = session.conversationId, api = active.api
    const ownerTurnId = session.currentTurn?.id ?? session.queue[0]?.id
    let failure: unknown, landed = false, intendedPaused = false
    const change = (type: string, payload: unknown, apply: () => void) => this.serial(id, async () => { apply(); await this.commit(session, type, payload, [], api) })
    try {
      let turn: QueuedTurn | undefined
      await this.bounded(this.serial(id, async () => {
        turn = session.currentTurn ? undefined : session.queue.shift()
        session.currentTurn ??= turn
        active.untouched = Boolean(turn && !turn.text.trim().startsWith('/') && !turn.callbackData)
        if (session.currentTurn?.channelActor && session.thread) {
          session.thread.channelSenderId = session.currentTurn.channelActor.senderId
          session.thread.channelTopicId = session.currentTurn.channelActor.topicId
          session.thread.channelChatType = session.currentTurn.channelActor.chatType
        }
        session.state = 'PREPARING'; session.runId = crypto.randomUUID(); session.error = null
        await this.commit(session, 'started', { turnId: session.currentTurn?.id }, turn ? [{ dataset: 'turn_queue', operation: 'upsert', values: record(turn.id, id, 'ACTIVE', turn) }] : [], api)
      }), 'Saving the conversation is taking too long, so nothing was sent. Press Continue to try again.')
      await this.ports.run(session, turn, {
        api, signal: active.controller.signal, shouldSteer: () => active.steer,
        state: async (state, tool) => {
          const waiting = state === 'AWAITING_APPROVAL' || state === 'AWAITING_QUESTION'
          if (state !== 'INFERRING' && state !== 'COMPACTING' && !(tool && catalogTools.has(tool))) active.untouched = false
          if (!waiting && !active.occupied) await new Promise<void>((resolve, reject) => {
            const abort = () => { this.capacityWaiters = this.capacityWaiters.filter(value => value !== waiter); reject(new Error('Execution interrupted')) }
            const waiter = { id, resume: () => { active.controller.signal.removeEventListener('abort', abort); resolve() } }
            active.controller.signal.addEventListener('abort', abort, { once: true })
            this.capacityWaiters.push(waiter)
            if (active.controller.signal.aborted) abort()
            this.schedule()
          })
          await change('state', { state }, () => { assertTransition(session.state, state); session.state = state })
          if (waiting) { active.occupied = false; this.schedule() }
        },
        message: message => {
          const value = { ...message, id: message.id ?? crypto.randomUUID() }
          if (touchesEffects(value, session.thread!.messages)) active.untouched = false
          return change('message', value, () => { if (!session.thread!.messages.some(item => item.id === value.id)) session.thread!.messages.push(value); session.streamingText = '' })
        },
        stream: text => change('stream', {}, () => { session.streamingText = text }),
        context: usage => change('context', usage, () => { session.context = usage }),
        update: update => change('conversation.updated', {}, () => update(session.thread!))
      })
      await this.bounded(this.serial(id, async () => {
        if (active.controller.signal.aborted) throw new Error('Execution interrupted')
        if (session.thread?.plan?.status === 'review' && session.queue.length) session.thread.plan.status = 'changes'
        session.state = session.thread?.plan?.status === 'review' || session.thread?.quiz?.source.startsWith('assistant-question:') ? 'AWAITING_QUESTION' : session.queue.length ? 'QUEUED' : 'IDLE'
        session.paused = intendedPaused = session.state === 'AWAITING_QUESTION'
        const finished = session.currentTurn
        session.currentTurn = undefined
        await this.commit(session, 'finished', {}, finished ? [{ dataset: 'turn_queue', operation: 'upsert', values: record(finished.id, id, 'COMPLETED', finished) }] : [], api)
        landed = true
      }), 'The reply is done, but saving it is taking too long. It stays in this chat; nothing else runs until you continue.')
    } catch (error) {
      failure = error
      const settle = async () => {
        if (session.streamingText) session.thread?.messages.push({ id: crypto.randomUUID(), role: 'assistant', content: session.streamingText, ts: Date.now(), error: true })
        if (!active.steer && !active.controller.signal.aborted) session.thread?.messages.push(failureReply(session.runId, error))
        if (!active.steer && active.controller.signal.aborted) { const stopped = session.thread?.messages.find(message => message.role === 'user' && message.id === session.currentTurn?.id); if (stopped) stopped.stopped = true }
        session.streamingText = ''
        session.state = active.steer ? 'QUEUED' : active.controller.signal.aborted ? 'INTERRUPTED' : 'FAILED'
        session.paused = !active.steer
        if (active.steer) session.currentTurn = undefined
        session.error = active.controller.signal.aborted ? null : String(error)
        await this.commit(session, 'interrupted', { error: session.error }, [], active.api)
      }
      if (error instanceof StalledSave) {
        // Show the stall now and hold the queue; the durable record follows the stalled write instead of waiting behind it.
        session.paused = true
        this.show(session, { state: active.controller.signal.aborted ? 'INTERRUPTED' : 'FAILED', streamingText: '', error: active.controller.signal.aborted ? null : String(error) }, active.api)
        void this.serial(id, async () => {
          if (!landed) return settle()
          if (session.paused === intendedPaused) return
          session.paused = intendedPaused
          await this.commit(session, 'save.recovered', {}, [], active.api)
          this.schedule()
        }).catch(() => {})
      } else await this.serial(id, settle)
    } finally {
      if (ownerTurnId && session.currentTurn?.id !== ownerTurnId) this.turnOwners.delete(ownerTurnId)
      active.completed = true; active.occupied = false; this.schedule()
      try { await this.ports.project(session, false, active.api) }
      catch (error) { failure ??= error; throw error }
      finally {
        if (ownerTurnId) {
          this.turnResults.set(ownerTurnId, { snapshot: structuredClone(session), ...(failure ? { error: failure } : {}), ...(failure && active.controller.signal.aborted && !active.steer && active.untouched ? { untouched: true } : {}) })
          // Each result holds a whole conversation; a waiter whose result was dropped reads the session instead.
          if (this.turnResults.size > 32) this.turnResults.delete(this.turnResults.keys().next().value!)
        }
        this.active.delete(id); this.notify(); this.schedule()
      }
    }
  }

  async waitForTurn(id: string, turnId?: string, signal?: AbortSignal): Promise<SessionSnapshot> {
    // A cancelled caller's turn never runs later: a running turn is stopped, a still-queued one is withdrawn from the queue.
    let withdrawing: Promise<void> | undefined
    const cancel = () => {
      const session = this.sessions.get(id), active = this.active.get(id)
      // The caller's operation closes with this cancel, so the stopped run records INTERRUPTED through the background repository, as withdraw does; its late content keeps the closed owner and is still rejected.
      if (turnId && active && session?.currentTurn?.id === turnId) active.api = undefined
      if (!turnId || session?.currentTurn?.id === turnId) active?.controller.abort()
      else if (session?.queue.some(turn => turn.id === turnId)) withdrawing ??= this.withdraw(id, turnId)
      this.notify()
    }
    signal?.addEventListener('abort', cancel)
    try {
      for (;;) {
        let wake!: () => void
        const change = new Promise<void>(resolve => { wake = resolve })
        this.changed.add(wake)
        try {
          const result = turnId ? this.turnResults.get(turnId) : undefined
          if (result) { if (result.error) throw signal?.aborted && result.untouched ? notApplied(signal.reason) : result.error; return structuredClone(result.snapshot) }
          if (signal?.aborted) {
            cancel(); await withdrawing
            if (!turnId || this.sessions.get(id)?.currentTurn?.id === turnId) await this.active.get(id)?.task.catch(() => {})
            throw turnId && this.turnResults.get(turnId)?.untouched ? notApplied(signal.reason) : signal.reason ?? new Error('Execution cancelled')
          }
          const session = this.sessions.get(id)
          if (!session) throw new Error('Conversation is unavailable')
          const active = this.active.get(id)
          const pending = turnId ? session.queue.some(turn => turn.id === turnId) || session.currentTurn?.id === turnId : session.queue.length > 0 || Boolean(session.currentTurn)
          if (!active && ['FAILED', 'INTERRUPTED'].includes(session.state)) throw new Error(session.error ?? 'Execution interrupted')
          if (!pending && !active) return structuredClone(session)
          if (!active && session.paused) throw new Error('The submitted turn is paused and requires continuation')
          await change
        } finally { this.changed.delete(wake) }
      }
    } finally { signal?.removeEventListener('abort', cancel) }
  }

  private withdraw(id: string, turnId: string): Promise<void> {
    return this.serial(id, async () => {
      const session = this.sessions.get(id)
      if (!session) return
      if (session.currentTurn?.id === turnId) { this.active.get(id)?.controller.abort(); return }
      const turn = session.queue.find(value => value.id === turnId)
      if (!turn) return
      session.queue = session.queue.filter(value => value.id !== turnId)
      if (!session.queue.length && !this.active.has(id) && session.state === 'QUEUED') session.state = 'IDLE'
      // The caller's own operation is already cancelled, so the background repository records the withdrawal.
      await this.commit(session, 'queue.changed', { turnId, withdrawn: true }, [{ dataset: 'turn_queue', operation: 'upsert', values: record(turnId, id, 'REMOVED', turn) }])
      this.turnOwners.delete(turnId)
    }).catch(() => {})
  }

  async close(): Promise<void> {
    this.closing = true
    await Promise.all([...this.active.keys()].map(id => this.stop(id)))
    await Promise.allSettled([...this.active.values()].map(value => value.task))
    await Promise.allSettled([...this.writes.values()])
  }
}
