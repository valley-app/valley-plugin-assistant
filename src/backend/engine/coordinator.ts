import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
type OwnerApi = PluginBackendOperationContext['api']
import type { AiChatThread, AiMessage } from '../../types'
import type { ContextUsage } from '../../contracts/context'
import type { QueuedTurn, SessionEvent, SessionSnapshot, SessionState, TurnSubmission } from '../../contracts/execution'
import { AssistantRepository, record } from '../persistence/repositories'
import { assertTransition } from './stateMachine'
import { transportValue } from '../transport'
import type { TurnAdmission } from './responsiveness'

export interface RunControls {
  api?: OwnerApi
  signal: AbortSignal
  shouldSteer(): boolean
  state(state: SessionState): Promise<void>
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

export class SessionCoordinator {
  private turnResults = new Map<string, { snapshot: SessionSnapshot; error?: unknown }>()
  private changed = new Set<() => void>()
  private notify(): void { for (const notify of this.changed) notify() }
  private committed = new Map<string, SessionSnapshot>()
  private turnOwners = new Map<string, OwnerApi>()
  private continuationOwners = new Map<string, OwnerApi>()
  private scoped(api?: OwnerApi): AssistantRepository { return api ? new AssistantRepository(api.data) : this.repository }
  private sessions = new Map<string, SessionSnapshot>()
  private active = new Map<string, { controller: AbortController; steer: boolean; occupied: boolean; completed: boolean; task: Promise<void>; api?: OwnerApi }>()
  private capacityWaiters: Array<{ id: string; resume(): void }> = []
  private writes = new Map<string, Promise<unknown>>()
  private closing = false
  private rejectedAdmissions = new Set<string>()

  constructor(private repository: AssistantRepository, private ports: CoordinatorPorts, private concurrency = 4) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid conversation concurrency')
  }

  async restore(): Promise<void> {
    for (const session of await this.repository.rows<SessionSnapshot>('sessions')) {
      if (await this.repository.get('conversation_deletions', session.conversationId)) continue
      this.sessions.set(session.conversationId, session)
      this.committed.set(session.conversationId, structuredClone(session))
      for (const turn of [...session.queue]) if (turn.admissionPending) await this.rejectAdmission(turn, new Error('Message admission was interrupted before dispatch. Submit a new instruction.'))
      const held = session.queue.filter(turn => turn.admissionPending === false)
      for (const turn of held) turn.editing = true
      const recovering = !['IDLE', 'AWAITING_QUESTION', 'AWAITING_APPROVAL', 'FAILED', 'INTERRUPTED'].includes(session.state)
      if (recovering) {
        session.state = 'INTERRUPTED'; session.paused = true
        session.error = 'Execution was interrupted. Review pending work and choose Continue.'
      }
      if (recovering || held.length) await this.commit(session, 'recovered', {}, held.map(turn => ({ dataset: 'turn_queue', operation: 'upsert', values: record(turn.id, session.conversationId, 'PENDING', turn) })))
      await this.ports.project(session, true)
    }
  }

  snapshot(id: string): SessionSnapshot | null { return transportValue(this.sessions.get(id) ?? null) }

  async initialize(thread: AiChatThread, api?: OwnerApi): Promise<SessionSnapshot> {
    return this.serial(thread.id, async () => {
      const existing = this.sessions.get(thread.id)
      if (existing) return structuredClone(existing)
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
      this.continuationOwners.delete(id); this.committed.delete(id)
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
      this.continuationOwners.delete(id); this.committed.delete(id); this.sessions.delete(id); this.notify()
      return [...new Set(turns)].sort()
    })
  }

  async change(id: string, operation: (thread: AiChatThread) => Promise<{ turn?: TurnSubmission; effects?: Parameters<AssistantRepository['commit']>[3] }>, api?: OwnerApi): Promise<void> {
    await this.serial(id, async () => {
      const session = this.sessions.get(id)
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
      const event = await this.scoped(api).commit(session, type, payload, effects)
      this.committed.set(session.conversationId, structuredClone(session))
      if (publish) { this.ports.publish(transportValue(session), transportValue(event), api); this.notify() }
      return event
    } catch (error) {
      const previous = this.committed.get(session.conversationId)
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
      const turn: QueuedTurn = { admissionPending: input.admissionPending, targetReference: input.targetReference, inputFingerprint: input.inputFingerprint, questionId: input.questionId, callbackData: input.callbackData, channelActor: input.channelActor, origin: input.origin, id: input.id, conversationId: input.conversationId, text: input.text, attachments: input.attachments ?? [], createdAt: Date.now(), priority: 0, editing: false }
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
    await this.serial(id, async () => {
      const session = this.sessions.get(id)
      if (!session) return
      session.paused = true
      await this.commit(session, 'stop.requested', {}, [], api)
      this.active.get(id)?.controller.abort()
      if (!this.active.has(id)) { session.state = 'INTERRUPTED'; await this.commit(session, 'interrupted', {}, [], api) }
    })
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
      const active = { controller: new AbortController(), steer: false, occupied: true, completed: false, task: Promise.resolve(), api: this.turnOwners.get(session.currentTurn?.id ?? session.queue[0]?.id ?? '') ?? this.continuationOwners.get(session.conversationId) }
      this.active.set(session.conversationId, active)
      active.task = this.execute(session, active)
      void active.task.catch(() => {})
    }
  }

  private async execute(session: SessionSnapshot, active: { controller: AbortController; steer: boolean; occupied: boolean; completed: boolean; api?: OwnerApi }): Promise<void> {
    const id = session.conversationId, api = active.api
    const ownerTurnId = session.currentTurn?.id ?? session.queue[0]?.id
    let failure: unknown
    const change = (type: string, payload: unknown, apply: () => void) => this.serial(id, async () => { apply(); await this.commit(session, type, payload, [], api) })
    try {
      let turn: QueuedTurn | undefined
      await this.serial(id, async () => {
        turn = session.currentTurn ? undefined : session.queue.shift()
        session.currentTurn ??= turn
        if (session.currentTurn?.channelActor && session.thread) {
          session.thread.channelSenderId = session.currentTurn.channelActor.senderId
          session.thread.channelTopicId = session.currentTurn.channelActor.topicId
          session.thread.channelChatType = session.currentTurn.channelActor.chatType
        }
        session.state = 'PREPARING'; session.runId = crypto.randomUUID(); session.error = null
        await this.commit(session, 'started', { turnId: session.currentTurn?.id }, turn ? [{ dataset: 'turn_queue', operation: 'upsert', values: record(turn.id, id, 'ACTIVE', turn) }] : [], api)
      })
      await this.ports.run(session, turn, {
        api, signal: active.controller.signal, shouldSteer: () => active.steer,
        state: async state => {
          const waiting = state === 'AWAITING_APPROVAL' || state === 'AWAITING_QUESTION'
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
          return change('message', value, () => { if (!session.thread!.messages.some(item => item.id === value.id)) session.thread!.messages.push(value); session.streamingText = '' })
        },
        stream: text => change('stream', {}, () => { session.streamingText = text }),
        context: usage => change('context', usage, () => { session.context = usage }),
        update: update => change('conversation.updated', {}, () => update(session.thread!))
      })
      await this.serial(id, async () => {
        if (active.controller.signal.aborted) throw new Error('Execution interrupted')
        if (session.thread?.plan?.status === 'review' && session.queue.length) session.thread.plan.status = 'changes'
        session.state = session.thread?.plan?.status === 'review' || session.thread?.quiz?.source.startsWith('assistant-question:') ? 'AWAITING_QUESTION' : session.queue.length ? 'QUEUED' : 'IDLE'
        session.paused = session.state === 'AWAITING_QUESTION'
        const finished = session.currentTurn
        session.currentTurn = undefined
        await this.commit(session, 'finished', {}, finished ? [{ dataset: 'turn_queue', operation: 'upsert', values: record(finished.id, id, 'COMPLETED', finished) }] : [], api)
      })
    } catch (error) {
      failure = error
      await this.serial(id, async () => {
        if (session.streamingText) session.thread?.messages.push({ id: crypto.randomUUID(), role: 'assistant', content: session.streamingText, ts: Date.now(), error: true })
        session.streamingText = ''
        session.state = active.steer ? 'QUEUED' : active.controller.signal.aborted ? 'INTERRUPTED' : 'FAILED'
        session.paused = !active.steer
        if (active.steer) session.currentTurn = undefined
        session.error = active.controller.signal.aborted ? null : String(error)
        await this.commit(session, 'interrupted', { error: session.error }, [], api)
      })
    } finally {
      if (ownerTurnId && session.currentTurn?.id !== ownerTurnId) this.turnOwners.delete(ownerTurnId)
      active.completed = true; active.occupied = false; this.schedule()
      try { await this.ports.project(session, false, api) }
      catch (error) { failure ??= error; throw error }
      finally {
        if (ownerTurnId) {
          this.turnResults.set(ownerTurnId, { snapshot: structuredClone(session), ...(failure ? { error: failure } : {}) })
          if (this.turnResults.size > 256) this.turnResults.delete(this.turnResults.keys().next().value!)
        }
        this.active.delete(id); this.notify(); this.schedule()
      }
    }
  }

  async waitForTurn(id: string, turnId?: string, signal?: AbortSignal): Promise<SessionSnapshot> {
    const cancel = () => { const session = this.sessions.get(id); if (!turnId || session?.currentTurn?.id === turnId) this.active.get(id)?.controller.abort(); this.notify() }
    signal?.addEventListener('abort', cancel)
    try {
      for (;;) {
        let wake!: () => void
        const change = new Promise<void>(resolve => { wake = resolve })
        this.changed.add(wake)
        try {
          const result = turnId ? this.turnResults.get(turnId) : undefined
          if (result) { if (result.error) throw result.error; return structuredClone(result.snapshot) }
          if (signal?.aborted) { cancel(); await this.active.get(id)?.task.catch(() => {}); throw signal.reason ?? new Error('Execution cancelled') }
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

  async close(): Promise<void> {
    this.closing = true
    await Promise.all([...this.active.keys()].map(id => this.stop(id)))
    await Promise.allSettled([...this.active.values()].map(value => value.task))
    await Promise.allSettled([...this.writes.values()])
  }
}
