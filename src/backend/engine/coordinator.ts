import type { AiChatThread, AiMessage } from '../../types'
import type { ContextUsage } from '../../contracts/context'
import type { QueuedTurn, SessionEvent, SessionSnapshot, SessionState, TurnSubmission } from '../../contracts/execution'
import { AssistantRepository, record } from '../persistence/repositories'
import { assertTransition } from './stateMachine'

export interface RunControls {
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
  project(session: SessionSnapshot): Promise<void>
  publish(session: SessionSnapshot, event: SessionEvent): void
}

export class SessionCoordinator {
  private sessions = new Map<string, SessionSnapshot>()
  private active = new Map<string, { controller: AbortController; steer: boolean; occupied: boolean; completed: boolean; task: Promise<void> }>()
  private capacityWaiters: Array<{ id: string; resume(): void }> = []
  private writes = new Map<string, Promise<unknown>>()
  private closing = false

  constructor(private repository: AssistantRepository, private ports: CoordinatorPorts, private concurrency = 4) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid conversation concurrency')
  }

  async restore(): Promise<void> {
    for (const session of await this.repository.rows<SessionSnapshot>('sessions')) {
      if (await this.repository.get('conversation_deletions', session.conversationId)) continue
      this.sessions.set(session.conversationId, session)
      if (!['IDLE', 'AWAITING_QUESTION', 'AWAITING_APPROVAL'].includes(session.state)) {
        session.state = 'INTERRUPTED'; session.paused = true
        session.error = 'Execution was interrupted. Review pending work and choose Continue.'
        await this.commit(session, 'recovered', {})
      }
      await this.ports.project(session)
    }
  }

  snapshot(id: string): SessionSnapshot | null { return structuredClone(this.sessions.get(id) ?? null) }

  async initialize(thread: AiChatThread): Promise<SessionSnapshot> {
    return this.serial(thread.id, async () => {
      const existing = this.sessions.get(thread.id)
      if (existing) return structuredClone(existing)
      const session: SessionSnapshot = { conversationId: thread.id, revision: 0, state: 'IDLE', runId: null, streamingText: '', queue: [], paused: false, error: null, context: null, thread: structuredClone(thread) }
      this.sessions.set(thread.id, session)
      await this.commit(session, 'created', {}, [{ dataset: 'conversation_deletions', operation: 'delete', key: { id: thread.id } }])
      return structuredClone(session)
    })
  }

  async remove(id: string): Promise<void> {
    await this.stop(id)
    await this.active.get(id)?.task.catch(() => {})
    await this.serial(id, async () => {
      await this.repository.data.transaction([{ dataset: 'conversation_deletions', operation: 'upsert', values: record(id, id, 'DELETED', { id, deletedAt: Date.now() }) }, { dataset: 'sessions', operation: 'delete', key: { id } }, { dataset: 'quiz_sessions', operation: 'delete', key: { id } }])
      this.sessions.delete(id)
    })
  }

  async change(id: string, operation: (thread: AiChatThread) => Promise<{ turn?: TurnSubmission; effects?: Parameters<AssistantRepository['commit']>[3] }>): Promise<void> {
    await this.serial(id, async () => {
      const session = this.sessions.get(id)
      if (!session?.thread || this.active.get(id) && !this.active.get(id)!.completed) throw new Error('Conversation must be idle before this action')
      const changed = structuredClone(session.thread)
      const { turn: input, effects = [] } = await operation(changed)
      session.thread = changed
      if (input) {
        const known = await this.repository.get<QueuedTurn>('turn_queue', input.id)
        if (!known) {
          const turn: QueuedTurn = { ...input, attachments: input.attachments ?? [], createdAt: Date.now(), priority: 0, editing: false }
          session.queue.push(turn)
          effects.push({ dataset: 'turn_queue', operation: 'insert', values: record(turn.id, id, 'PENDING', turn) })
        }
        session.paused = false; session.state = 'QUEUED'; session.error = null
      }
      await this.commit(session, 'conversation.changed', {}, effects)
      await this.ports.project(session)
      this.schedule()
    })
  }

  private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const task = (this.writes.get(id) ?? Promise.resolve()).catch(() => {}).then(operation)
    this.writes.set(id, task)
    void task.finally(() => { if (this.writes.get(id) === task) this.writes.delete(id) }).catch(() => {})
    return task
  }

  private async commit(session: SessionSnapshot, type: string, payload: unknown, effects: Parameters<AssistantRepository['commit']>[3] = []): Promise<void> {
    try {
      const event = await this.repository.commit(session, type, payload, effects)
      this.ports.publish(structuredClone(session), event)
    } catch (error) {
      const previous = await this.repository.get<SessionSnapshot>('sessions', session.conversationId)
      if (previous) {
        for (const key of Object.keys(session)) delete (session as unknown as Record<string, unknown>)[key]
        Object.assign(session, previous)
      } else this.sessions.delete(session.conversationId)
      throw error
    }
  }

  async enqueue(input: TurnSubmission, effects: Parameters<AssistantRepository['commit']>[3] = []): Promise<SessionSnapshot> {
    if (this.closing) throw new Error('Assistant is stopping')
    return this.serial(input.conversationId, async () => {
      let session = this.sessions.get(input.conversationId)
      const known = await this.repository.get<QueuedTurn>('turn_queue', input.id)
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
      const turn: QueuedTurn = { inputFingerprint: input.inputFingerprint, questionId: input.questionId, callbackData: input.callbackData, channelActor: input.channelActor, origin: input.origin, id: input.id, conversationId: input.conversationId, text: input.text, attachments: input.attachments ?? [], createdAt: Date.now(), priority: 0, editing: false }
      session.queue.push(turn)
      if (session.state === 'IDLE') session.state = 'QUEUED'
      await this.commit(session, 'enqueued', turn, [{ dataset: 'conversation_deletions', operation: 'delete', key: { id: input.conversationId } }, { dataset: 'turn_queue', operation: 'insert', values: record(turn.id, turn.conversationId, 'PENDING', turn) }, ...turn.attachments.flatMap(attachment => attachment.id ? [{ dataset: 'attachment_refs', operation: 'upsert' as const, values: { attachmentId: attachment.id, chatId: input.conversationId } }] : []), ...effects])
      this.schedule()
      return structuredClone(session)
    })
  }

  async edit(id: string, turnId: string, patch: { text?: string; editing?: boolean; index?: number; remove?: boolean }): Promise<void> {
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
      await this.commit(session, 'queue.changed', { turnId }, [{ dataset: 'turn_queue', operation: 'upsert', values: record(turnId, id, patch.remove ? 'REMOVED' : 'PENDING', turn) }])
      this.schedule()
    })
  }

  async steer(id: string, turnId: string): Promise<void> {
    await this.edit(id, turnId, { index: 0, editing: false })
    await this.serial(id, async () => {
      const session = this.sessions.get(id)!
      session.paused = false
      const active = this.active.get(id)
      if (active) {
        active.steer = true
        if (session.state === 'INFERRING' || session.state === 'PREPARING') active.controller.abort()
      } else if (session.state !== 'QUEUED') session.state = 'QUEUED'
      await this.commit(session, 'steer.requested', { turnId })
      this.schedule()
    })
  }

  async stop(id: string): Promise<void> {
    await this.serial(id, async () => {
      const session = this.sessions.get(id)
      if (!session) return
      session.paused = true
      await this.commit(session, 'stop.requested', {})
      this.active.get(id)?.controller.abort()
      if (!this.active.has(id)) { session.state = 'INTERRUPTED'; await this.commit(session, 'interrupted', {}) }
    })
  }

  async resume(id: string): Promise<void> {
    await this.serial(id, async () => {
      const session = this.sessions.get(id)
      if (!session || this.active.has(id)) return
      session.paused = false; session.error = null; session.state = 'QUEUED'
      await this.commit(session, 'continued', {})
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
      if (this.active.has(session.conversationId) || session.paused || session.state !== 'QUEUED' || session.queue[0]?.editing) continue
      const active = { controller: new AbortController(), steer: false, occupied: true, completed: false, task: Promise.resolve() }
      this.active.set(session.conversationId, active)
      active.task = this.execute(session, active)
      void active.task.catch(() => {})
    }
  }

  private async execute(session: SessionSnapshot, active: { controller: AbortController; steer: boolean; occupied: boolean; completed: boolean }): Promise<void> {
    const id = session.conversationId
    const change = (type: string, payload: unknown, apply: () => void) => this.serial(id, async () => { apply(); await this.commit(session, type, payload) })
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
        await this.commit(session, 'started', { turnId: session.currentTurn?.id }, turn ? [{ dataset: 'turn_queue', operation: 'upsert', values: record(turn.id, id, 'ACTIVE', turn) }] : [])
      })
      await this.ports.run(session, turn, {
        signal: active.controller.signal, shouldSteer: () => active.steer,
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
        await this.commit(session, 'finished', {}, finished ? [{ dataset: 'turn_queue', operation: 'upsert', values: record(finished.id, id, 'COMPLETED', finished) }] : [])
      })
    } catch (error) {
      await this.serial(id, async () => {
        if (session.streamingText) session.thread?.messages.push({ id: crypto.randomUUID(), role: 'assistant', content: session.streamingText, ts: Date.now(), error: true })
        session.streamingText = ''
        session.state = active.steer ? 'QUEUED' : active.controller.signal.aborted ? 'INTERRUPTED' : 'FAILED'
        session.paused = !active.steer
        if (active.steer) session.currentTurn = undefined
        session.error = active.controller.signal.aborted ? null : String(error)
        await this.commit(session, 'interrupted', { error: session.error })
      })
    } finally {
      active.completed = true; active.occupied = false; this.schedule()
      try { await this.ports.project(session) } finally { this.active.delete(id); this.schedule() }
    }
  }

  async close(): Promise<void> {
    this.closing = true
    await Promise.all([...this.active.keys()].map(id => this.stop(id)))
    await Promise.allSettled([...this.active.values()].map(value => value.task))
    await Promise.allSettled([...this.writes.values()])
  }
}
