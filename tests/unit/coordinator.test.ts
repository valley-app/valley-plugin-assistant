import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
import { assertCommandOutput } from '../commandContracts'
import { describe, expect, it, vi } from 'vitest'
import { SessionCoordinator, type CoordinatorPorts } from '../../src/backend/engine/coordinator'
import { AssistantRepository } from '../../src/backend/persistence/repositories'
import { datasetFixture } from '../backendDatasetFixture'
import type { TurnSubmission } from '../../src/contracts/execution'

const submission = (conversationId: string, id = crypto.randomUUID()): TurnSubmission => ({ id, conversationId, text: 'Inspect moss', thread: { id: conversationId, title: 'Moss', createdAt: 1, updatedAt: 1, messages: [] } })
const until = async (test: () => boolean) => vi.waitFor(() => expect(test()).toBe(true))

describe('durable session coordinator', () => {
  it('retains cancelled admission identity after restart and does not resume an unadmitted turn', async () => {
    const data = datasetFixture(), repository = new AssistantRepository(data), run = vi.fn<CoordinatorPorts['run']>(async () => {})
    const ports = { publish: vi.fn(), project: async () => {}, run }
    const first = new SessionCoordinator(repository, ports)
    const input = { ...submission('pending-admission'), admissionPending: true }
    await first.enqueue(input)
    expect(run).not.toHaveBeenCalled()
    await first.close()
    const restored = new SessionCoordinator(repository, ports)
    try {
      await restored.restore()
      expect(restored.snapshot(input.conversationId)).toMatchObject({ state: 'FAILED', queue: [], paused: true })
      expect((await data.dataset('turn_queue').get({ id: input.id }))?.state).toBe('REMOVED')
      await restored.enqueue(input)
      expect(run).not.toHaveBeenCalled()
    } finally { await restored.close() }
  })
  it('holds recovered admitted queue entries for review instead of draining them after a fresh message', async () => {
    const repository = new AssistantRepository(datasetFixture()), run = vi.fn<CoordinatorPorts['run']>(async () => {})
    const ports = { publish: vi.fn(), project: async () => {}, run }
    const first = new SessionCoordinator(repository, ports), input = { ...submission('held-admission'), admissionPending: true }
    await first.enqueue(input); await first.stop(input.conversationId)
    await first.acceptAdmission(input.conversationId, input.id, { check: () => {}, step: (_stage, work) => work() })
    await first.close()
    const restored = new SessionCoordinator(repository, ports)
    try {
      await restored.restore()
      expect(restored.snapshot(input.conversationId)?.queue[0]).toMatchObject({ id: input.id, editing: true, admissionPending: false })
      const fresh = submission(input.conversationId)
      await restored.enqueue(fresh); await restored.steer(input.conversationId, fresh.id)
      await restored.waitForTurn(input.conversationId, fresh.id)
      expect(run).toHaveBeenCalledOnce()
      expect(run.mock.calls[0][1]?.id).toBe(fresh.id)
      expect(restored.snapshot(input.conversationId)?.queue[0]?.id).toBe(input.id)
    } finally { await restored.close() }
  })
  it('streams separate conversations simultaneously and stops only the selected conversation', async () => {
    const controlsByChat = new Map<string, Parameters<CoordinatorPorts['run']>[2]>()
    let finishFern!: () => void
    const coordinator = new SessionCoordinator(new AssistantRepository(datasetFixture()), { publish: vi.fn(), project: async () => {}, run: async (session, _turn, controls) => {
      controlsByChat.set(session.conversationId, controls)
      await controls.state('INFERRING')
      await controls.stream(session.conversationId)
      if (session.conversationId === 'moss') await new Promise<void>(resolve => controls.signal.addEventListener('abort', () => resolve(), { once: true }))
      else await new Promise<void>(resolve => { finishFern = resolve })
    } })
    await coordinator.enqueue(submission('moss'))
    await coordinator.enqueue(submission('fern'))
    await until(() => Boolean(finishFern) && coordinator.snapshot('moss')?.state === 'INFERRING')
    assertCommandOutput('command.session.snapshot', {}, coordinator.snapshot('moss'))
    assertCommandOutput('command.session.submit', {}, coordinator.snapshot('fern'))
    expect(coordinator.snapshot('moss')?.streamingText).toBe('moss')
    expect(coordinator.snapshot('fern')?.streamingText).toBe('fern')
    await coordinator.stop('moss')
    await until(() => coordinator.snapshot('moss')?.state === 'INTERRUPTED')
    expect(controlsByChat.get('fern')!.signal.aborted).toBe(false)
    await controlsByChat.get('fern')!.stream('Fern is still writing')
    expect(coordinator.snapshot('fern')?.streamingText).toBe('Fern is still writing')
    finishFern()
    await until(() => coordinator.snapshot('fern')?.state === 'IDLE')
    await coordinator.close()
  })

  it('accepts fresh steering while a failed run is still saving its final projection', async () => {
    let release!: () => void
    const saved = new Promise<void>(resolve => { release = resolve })
    const run = vi.fn<CoordinatorPorts['run']>(async () => {})
    run.mockRejectedValueOnce(new Error('Provider unavailable'))
    const project = vi.fn<CoordinatorPorts['project']>(async () => {})
    project.mockImplementationOnce(async () => saved)
    const coordinator = new SessionCoordinator(new AssistantRepository(datasetFixture()), { publish: vi.fn(), project, run })
    try {
      await coordinator.enqueue(submission('moss'))
      await until(() => project.mock.calls.length === 1)
      const fresh = submission('moss')
      await coordinator.enqueue(fresh)
      await coordinator.steer('moss', fresh.id)
      expect(coordinator.snapshot('moss')).toMatchObject({ state: 'QUEUED', paused: false, error: null })
      expect(coordinator.snapshot('moss')?.currentTurn).toBeUndefined()
      expect(run).toHaveBeenCalledOnce()
      release()
      await until(() => coordinator.snapshot('moss')?.state === 'IDLE')
      expect(run).toHaveBeenCalledTimes(2)
      expect(run.mock.calls[1][1]?.id).toBe(fresh.id)
    } finally { release(); await coordinator.close() }
  })

  it('releases capacity for a question and reacquires it before continuing', async () => {
    let answer!: () => void, finishOther!: () => void
    const events: string[] = []
    const coordinator = new SessionCoordinator(new AssistantRepository(datasetFixture()), { publish: vi.fn(), project: async () => {}, run: async (session, _turn, controls) => {
      await controls.state('INFERRING')
      if (session.conversationId === 'question') {
        await controls.state('AWAITING_QUESTION')
        await new Promise<void>(resolve => { answer = resolve })
        await controls.state('INFERRING')
        events.push('answered')
      } else { events.push('other'); await new Promise<void>(resolve => { finishOther = resolve }) }
    } }, 1)
    await coordinator.enqueue(submission('question'))
    await until(() => Boolean(answer))
    await coordinator.enqueue(submission('other'))
    await until(() => Boolean(finishOther))
    answer(); await new Promise(resolve => setTimeout(resolve, 10))
    expect(events).toEqual(['other'])
    finishOther(); await until(() => events.includes('answered'))
    await coordinator.close()
  })
  it('bounds parallel conversations and serializes each conversation', async () => {
    const releases: Array<() => void> = [], active = new Set<string>()
    const ports: CoordinatorPorts = { publish: vi.fn(), project: async () => {}, run: async (session, _turn, controls) => {
      expect(active.has(session.conversationId)).toBe(false)
      active.add(session.conversationId)
      await controls.state('INFERRING')
      await new Promise<void>(resolve => releases.push(resolve))
      active.delete(session.conversationId)
    } }
    const coordinator = new SessionCoordinator(new AssistantRepository(datasetFixture()), ports, 2)
    await coordinator.enqueue(submission('moss')); await coordinator.enqueue(submission('moss')); await coordinator.enqueue(submission('fern')); await coordinator.enqueue(submission('oak'))
    await until(() => releases.length === 2)
    expect(active.size).toBe(2)
    releases.shift()!(); await until(() => releases.length === 2)
    releases.shift()!(); releases.shift()!(); await until(() => releases.length === 1)
    releases.shift()!(); await until(() => active.size === 0)
    await coordinator.close()
  })
  it('deduplicates submissions durably and restores interruption without replay', async () => {
    const repository = new AssistantRepository(datasetFixture())
    const ports: CoordinatorPorts = { publish: vi.fn(), project: async () => {}, run: async (_session, _turn, controls) => {
      await controls.state('INFERRING')
      await controls.message({ id: 'reply', role: 'assistant', content: 'Moss identified' })
      await new Promise<void>(resolve => controls.signal.addEventListener('abort', () => resolve(), { once: true }))
    } }
    const coordinator = new SessionCoordinator(repository, ports)
    const input = submission('moss')
    await coordinator.enqueue(input); await coordinator.enqueue(input)
    await until(() => coordinator.snapshot('moss')?.state === 'INFERRING')
    await coordinator.enqueue(submission('moss'))
    await coordinator.close()
    const run = vi.fn(async () => {})
    const restored = new SessionCoordinator(repository, { ...ports, run })
    await restored.restore()
    expect(run).not.toHaveBeenCalled()
    expect(restored.snapshot('moss')).toMatchObject({ state: 'INTERRUPTED', paused: true, queue: [{ text: 'Inspect moss' }] })
    expect(restored.snapshot('moss')!.thread!.messages.filter(message => message.id === 'reply')).toHaveLength(1)
    await restored.close()
  })
  it('does not dispatch a turn when its transaction fails', async () => {
    const data = datasetFixture(), run = vi.fn(async () => {})
    vi.spyOn(data, 'transaction').mockRejectedValueOnce(new Error('Storage unavailable'))
    const coordinator = new SessionCoordinator(new AssistantRepository(data), { publish: vi.fn(), project: async () => {}, run })
    await expect(coordinator.enqueue(submission('moss'))).rejects.toThrow('Storage unavailable')
    expect(run).not.toHaveBeenCalled()
    expect(coordinator.snapshot('moss')).toBeNull()
    await coordinator.close()
  })
  it('keeps each submitted owner until its final projection and reports committed completion after a late cancel', async () => {
    const data = datasetFixture(), background = datasetFixture()
    const backgroundWrite = vi.spyOn(background, 'transaction')
    const owner = { data } as PluginBackendOperationContext['api']
    let finish!: () => void, publish!: () => void
    const coordinator = new SessionCoordinator(new AssistantRepository(background), { publish: vi.fn(), run: async (_session, _turn, controls) => {
      expect(controls.api).toBe(owner)
      await new Promise<void>(resolve => { finish = resolve })
      await controls.message({ role: 'assistant', content: 'Committed reply' })
    }, project: async (_session, _restore, api) => { expect(api).toBe(owner); await new Promise<void>(resolve => { publish = resolve }) } })
    const input = submission('owned'), controller = new AbortController()
    await coordinator.enqueue(input, [], owner)
    let completed = false
    const result = coordinator.waitForTurn(input.conversationId, input.id, controller.signal).then(value => { completed = true; return value })
    await until(() => Boolean(finish)); expect(completed).toBe(false)
    finish(); await until(() => Boolean(publish)); expect(completed).toBe(false)
    publish(); expect((await result).thread?.messages[0].content).toBe('Committed reply')
    controller.abort()
    expect((await coordinator.waitForTurn(input.conversationId, input.id, controller.signal)).state).toBe('IDLE')
    expect(backgroundWrite).not.toHaveBeenCalled()
    await coordinator.close()
  })

  it('rejects revoked late commits without ambient fallback while another operation completes', async () => {
    const data = datasetFixture(), background = datasetFixture()
    const backgroundWrite = vi.spyOn(background, 'transaction')
    let revoked = false, release!: () => void
    const scopedWrite = vi.fn<typeof data.transaction>(async operations => { if (revoked) throw new Error('Operation revoked'); return data.transaction(operations) })
    const owner = { data: { ...data, transaction: scopedWrite } } as unknown as PluginBackendOperationContext['api']
    const other = { data } as PluginBackendOperationContext['api']
    const coordinator = new SessionCoordinator(new AssistantRepository(background), { publish: vi.fn(), project: async () => {}, run: async (session, _turn, controls) => {
      if (session.conversationId === 'revoked') {
        expect(controls.api).toBe(owner)
        await new Promise<void>(resolve => { release = resolve })
        await controls.message({ role: 'assistant', content: 'Forbidden late message' })
      } else { expect(controls.api).toBe(other); await controls.message({ role: 'assistant', content: 'Independent reply' }) }
    } })
    const first = submission('revoked'), second = submission('allowed')
    await coordinator.enqueue(first, [], owner)
    await until(() => Boolean(release)); revoked = true
    const failed = coordinator.waitForTurn(first.conversationId, first.id)
    await coordinator.enqueue(second, [], other)
    expect((await coordinator.waitForTurn(second.conversationId, second.id)).thread?.messages[0].content).toBe('Independent reply')
    release(); await expect(failed).rejects.toThrow('Operation revoked')
    expect(coordinator.snapshot(first.conversationId)?.thread?.messages).toEqual([])
    expect(backgroundWrite).not.toHaveBeenCalled()
    await coordinator.close()
  })

  it('joins a cancelled run before rejecting and never commits its late message', async () => {
    const controller = new AbortController(), data = datasetFixture(), background = datasetFixture()
    const fallback = vi.spyOn(background, 'transaction')
    const owner = { data: { ...data, transaction: async (...args: Parameters<typeof data.transaction>) => { controller.signal.throwIfAborted(); return data.transaction(...args) } } } as unknown as PluginBackendOperationContext['api']
    let started = false, joined = false
    const coordinator = new SessionCoordinator(new AssistantRepository(background), { publish: vi.fn(), project: async () => { joined = true }, run: async (_session, _turn, controls) => {
      started = true
      await new Promise<void>(resolve => controls.signal.addEventListener('abort', () => resolve(), { once: true }))
      await controls.message({ role: 'assistant', content: 'Rejected after cancellation' })
    } })
    const input = submission('cancelled')
    await coordinator.enqueue(input, [], owner)
    const result = coordinator.waitForTurn(input.conversationId, input.id, controller.signal)
    await until(() => started); controller.abort(new Error('Caller cancelled'))
    await expect(result).rejects.toThrow('Caller cancelled')
    expect(joined).toBe(true)
    expect(coordinator.snapshot(input.conversationId)?.thread?.messages).toEqual([])
    expect(fallback).not.toHaveBeenCalled()
    await coordinator.close()
  })

})
