import { describe, expect, it, vi } from 'vitest'
import { SessionCoordinator, type CoordinatorPorts } from '../../src/backend/engine/coordinator'
import { AssistantRepository } from '../../src/backend/persistence/repositories'
import { datasetFixture } from '../backendDatasetFixture'
import type { TurnSubmission } from '../../src/contracts/execution'

const submission = (conversationId: string, id = crypto.randomUUID()): TurnSubmission => ({ id, conversationId, text: 'Inspect moss', thread: { id: conversationId, title: 'Moss', createdAt: 1, updatedAt: 1, messages: [] } })
const until = async (test: () => boolean) => vi.waitFor(() => expect(test()).toBe(true))

describe('durable session coordinator', () => {
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
})
