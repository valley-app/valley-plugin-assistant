import { vi } from 'vitest'
import { SessionCoordinator, type CoordinatorPorts } from '../src/backend/engine/coordinator'
import { AssistantRepository } from '../src/backend/persistence/repositories'
import type { SessionSnapshot, TurnSubmission } from '../src/contracts/execution'
import { datasetFixture } from './backendDatasetFixture'
import { createMockValleyApi, type MockOptions } from './mock'
import { encodePluginBackendOperationValue } from '@valley/plugin-sdk/pluginBackendOperations'

export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

export function sessionBackendFixture(options: MockOptions = {}) {
  const mock = createMockValleyApi(options)
  const data = datasetFixture(), repository = new AssistantRepository(data)
  const listeners = new Set<(value: unknown) => void>()
  const gates: Array<ReturnType<typeof deferred>> = []
  const model = vi.fn<CoordinatorPorts['run']>(async () => {})
  const persist = async (session: SessionSnapshot) => {
    if (!session.thread) return
    await mock.api.assistant.saveChat(structuredClone({ ...session.thread, pendingMessages: session.queue.map(turn => ({ id: turn.id, text: turn.text, attachments: turn.attachments })) }))
  }
  const project = vi.fn<CoordinatorPorts['project']>(persist)
  const ports: CoordinatorPorts = {
    publish: (session, event) => { for (const listener of listeners) listener({ session, event }) },
    project,
    run: async (session, turn, controls) => {
      if (turn) await controls.message({ id: turn.id, role: 'user', content: turn.text, displayContent: turn.text || undefined, attachmentIds: turn.attachments.flatMap(file => file.id ? [file.id] : []), attachmentFiles: turn.attachments.map(file => ({ fileName: file.fileName, path: file.path, kind: file.kind, mime: file.mime, metadata: file.metadata })) })
      await controls.state('INFERRING')
      await model(session, turn, controls)
    }
  }
  let coordinator = new SessionCoordinator(repository, ports)
  const originalCall = mock.api.backend.call, originalOn = mock.api.backend.on
  const approval = vi.fn(async (_input: unknown) => {})
  const call = vi.fn(async (method: string, raw: unknown) => {
    const input = raw as { conversationId: string; turnId: string; patch: Parameters<SessionCoordinator['edit']>[2] }
    if (method === 'session.snapshot') return coordinator.snapshot(input.conversationId)
    if (method === 'session.submit') {
      const submission = raw as TurnSubmission
      if (submission.thread && !mock.chatThreads.has(submission.conversationId)) await mock.api.assistant.saveChat(structuredClone(submission.thread))
      return coordinator.enqueue(submission)
    }
    if (method === 'session.queue') return coordinator.edit(input.conversationId, input.turnId, input.patch)
    if (method === 'session.steer') return coordinator.steer(input.conversationId, input.turnId)
    if (method === 'session.stop') return coordinator.stop(input.conversationId)
    if (method === 'session.resume') return coordinator.resume(input.conversationId)
    if (method === 'session.mode') return coordinator.change(input.conversationId, async thread => { thread.mode = 'plan'; if (thread.plan) thread.plan.status = 'changes'; return {} })
    if (method === 'plan.approve') return approval(raw)
    if (method === 'chat.capture' && coordinator.snapshot((raw as { id: string }).id)) return null
    if (method === 'projects.request' && (raw as { method?: string }).method === 'context') return { project: { id: 'forest' }, roots: [] }
    return originalCall(method, raw)
  })
  mock.api.backend.call = call as typeof mock.api.backend.call
  mock.api.backend.callOperation = (async (method, payload) => { encodePluginBackendOperationValue(payload); return call(method, payload) }) as typeof mock.api.backend.callOperation
  mock.api.backend.on = ((name, listener) => {
    if (name !== 'session.changed') return originalOn(name, listener)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }) as typeof mock.api.backend.on
  for (const method of ['clearChat', 'deleteChat'] as const) {
    const original = mock.api.assistant[method]
    mock.api.assistant[method] = async id => { await coordinator.remove(id); return original(id) }
  }
  return {
    ...mock, data, repository, model, project, persist, call, approval,
    get coordinator() { return coordinator },
    get listenerCount() { return listeners.size },
    gate() { const gate = deferred(); gates.push(gate); return gate },
    async restore() { coordinator = new SessionCoordinator(repository, ports); await coordinator.restore() },
    async cleanup() { gates.forEach(gate => gate.resolve()); await coordinator.close() }
  }
}
