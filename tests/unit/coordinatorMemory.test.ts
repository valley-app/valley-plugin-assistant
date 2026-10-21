import v8 from 'node:v8'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { SessionCoordinator, type CoordinatorPorts } from '../../src/backend/engine/coordinator'
import type { SessionSnapshot } from '../../src/contracts/execution'
import type { TurnAdmission } from '../../src/backend/engine/responsiveness'
import { AssistantRepository } from '../../src/backend/persistence/repositories'
import { datasetFixture } from '../backendDatasetFixture'

v8.setFlagsFromString('--expose-gc')
const gc = vm.runInNewContext('gc') as () => void
const heap = () => { gc(); gc(); return process.memoryUsage().heapUsed }
const thread = (id: string) => ({ id, title: 'Moss', createdAt: 1, updatedAt: 1, messages: Array.from({ length: 40 }, (_, index) => ({ id: `${id}-${index}`, role: 'user' as const, content: `Moss note ${index} `.repeat(60) })) })

describe('session coordinator memory', () => {
  // The plugin backend runs under a fixed memory cap. The fixture stores each row in memory too, so one copy here measures about two.
  it('keeps one in-memory copy of each finished conversation beside its stored row', async () => {
    const count = 150
    const start = heap()
    const copies = Array.from({ length: count }, (_, index) => structuredClone(thread(`copy-${index}`)))
    const oneCopy = heap() - start
    copies.length = 0
    const coordinator = new SessionCoordinator(new AssistantRepository(datasetFixture()), { publish: () => {}, project: async () => {}, run: async () => {} })
    const before = heap()
    for (let index = 0; index < count; index++) {
      const id = `moss-${index}`, turn = crypto.randomUUID()
      await coordinator.enqueue({ id: turn, conversationId: id, text: 'Inspect moss', thread: thread(id) })
      await coordinator.waitForTurn(id, turn)
    }
    const held = heap() - before
    expect(held / oneCopy).toBeLessThan(3)
    await coordinator.close()
  }, 60000)

  it('keeps messages only for running and recently used conversations and reloads the others with their state', async () => {
    // About 1 MB per conversation, like the largest stored chats; the transaction skips the fixture's whole-table rollback copy.
    const large = (id: string, size: number) => ({ id, title: 'Moss', createdAt: 1, updatedAt: 1, messages: Array.from({ length: 40 }, (_, index) => ({ id: `${id}-${index}`, role: 'user' as const, content: `${id} moss note ${index} `.padEnd(size, 'lichen ') })) })
    const data = datasetFixture()
    data.transaction = (async (operations: Array<{ dataset: string; operation: string; key?: Record<string, unknown>; values?: Record<string, unknown> }>) => {
      for (const operation of operations) {
        const table = data.dataset(operation.dataset)
        if (operation.operation === 'insert') await table.insert(operation.values as never)
        else if (operation.operation === 'delete') await table.delete(operation.key as never)
        else await table.upsert(operation.values as never)
      }
    }) as never
    const seen = new Map<string, number[]>()
    const run = async (session: SessionSnapshot, _turn: unknown, controls: Parameters<CoordinatorPorts['run']>[2]) => {
      seen.set(session.conversationId, [...(seen.get(session.conversationId) ?? []), session.thread!.messages.length])
      await controls.message({ id: `${session.conversationId}-reply-${session.thread!.messages.length}`, role: 'assistant', content: 'Forty patches.' })
    }
    const coordinator = new SessionCoordinator(new AssistantRepository(data), { publish: () => {}, project: async () => {}, run })
    const internal = coordinator as unknown as { sessions: Map<string, SessionSnapshot>; turnResults: Map<string, { snapshot: SessionSnapshot }> }
    const retained = () => [...internal.sessions.values(), ...[...internal.turnResults.values()].map(result => result.snapshot)].reduce((sum, session) => sum + (session.thread ? JSON.stringify(session.thread.messages).length : 0), 0)
    try {
      const held = { id: crypto.randomUUID(), conversationId: 'held-fern', text: 'Inspect fern', thread: { id: 'held-fern', title: 'Fern', createdAt: 1, updatedAt: 1, messages: [{ id: 'fern-0', role: 'user' as const, content: 'Fern note' }] }, admissionPending: true }
      await coordinator.enqueue(held)
      let largest = 0
      for (let index = 0; index < 50; index++) {
        const id = `moss-${index}`, thread = large(id, 24000 + index * 40), turn = crypto.randomUUID()
        largest = Math.max(largest, JSON.stringify([...thread.messages, { id: `${id}-reply-40`, role: 'assistant', content: 'Forty patches.' }]).length)
        await coordinator.enqueue({ id: turn, conversationId: id, text: 'Inspect moss', thread })
        expect((await coordinator.waitForTurn(id, turn)).thread?.messages).toHaveLength(41)
      }
      expect(largest).toBeGreaterThan(1000000)
      expect(retained()).toBeLessThanOrEqual(5 * largest)
      expect([...internal.sessions.values()].filter(session => session.thread).length).toBeLessThanOrEqual(5)

      const evicted = coordinator.snapshot('moss-0')!
      expect(evicted.thread).toBeUndefined()
      expect(evicted).toMatchObject({ state: 'IDLE', queue: [], paused: false })
      const reloaded = (await coordinator.load('moss-0'))!
      expect(reloaded.thread!.messages).toEqual([...large('moss-0', 24000).messages, { id: 'moss-0-reply-40', role: 'assistant', content: 'Forty patches.' }])
      expect(reloaded).toMatchObject({ revision: evicted.revision, state: 'IDLE', queue: [] })
      expect(((await data.dataset('sessions').get({ id: 'moss-0' }))!.payload as unknown as SessionSnapshot).revision).toBe(evicted.revision)

      const next = crypto.randomUUID()
      await coordinator.enqueue({ id: next, conversationId: 'moss-1', text: 'Inspect moss again' })
      const finished = await coordinator.waitForTurn('moss-1', next)
      expect(seen.get('moss-1')).toEqual([40, 41])
      expect(finished.thread!.messages).toHaveLength(42)
      expect(finished.revision).toBeGreaterThan(evicted.revision)

      const waiting = coordinator.snapshot('held-fern')!
      expect(waiting.thread?.messages).toHaveLength(1)
      expect(waiting.queue.map(turn => turn.id)).toEqual([held.id])
      await coordinator.acceptAdmission('held-fern', held.id, { check: () => {} } as unknown as TurnAdmission)
      expect((await coordinator.waitForTurn('held-fern', held.id)).thread?.messages).toHaveLength(2)
      expect(retained()).toBeLessThanOrEqual(5 * largest)
    } finally { await coordinator.close() }
  }, 120000)

  it('lets idle Telegram and WhatsApp conversations go back to their stored rows and reloads them for the next message', async () => {
    const channelThread = (id: string, index: number) => ({ id, title: 'Fern', createdAt: 1, updatedAt: 1, source: index % 2 ? 'whatsapp' as const : 'telegram' as const, channelId: index % 2 ? 'whatsapp' : 'telegram', chatRef: `fern-${index}`, messages: Array.from({ length: 20 }, (_, message) => ({ id: `${id}-${message}`, role: 'user' as const, content: `${id} fern note ${message} `.padEnd(12000, 'frond ') })) })
    const data = datasetFixture(), seen = new Map<string, Array<{ messages: number; sender?: string }>>()
    const run = async (session: SessionSnapshot, _turn: unknown, controls: Parameters<CoordinatorPorts['run']>[2]) => {
      seen.set(session.conversationId, [...(seen.get(session.conversationId) ?? []), { messages: session.thread!.messages.length, sender: session.thread!.channelSenderId }])
      await controls.message({ id: `${session.conversationId}-reply-${session.thread!.messages.length}`, role: 'assistant', content: 'Fronds counted.' })
    }
    const coordinator = new SessionCoordinator(new AssistantRepository(data), { publish: () => {}, project: async () => {}, run })
    const holding = (value: SessionCoordinator) => [...(value as unknown as { sessions: Map<string, SessionSnapshot> }).sessions.values()].filter(session => session.thread).map(session => session.conversationId)
    try {
      for (let index = 0; index < 20; index++) {
        const id = `channel-${index}`, turn = crypto.randomUUID()
        await coordinator.enqueue({ id: turn, conversationId: id, text: 'Count fronds', thread: channelThread(id, index), channelActor: { senderId: `sender-${index}` } })
        expect((await coordinator.waitForTurn(id, turn)).thread?.messages).toHaveLength(21)
      }
      expect(holding(coordinator)).toEqual(['channel-16', 'channel-17', 'channel-18', 'channel-19'])
      expect(coordinator.snapshot('channel-0')).toMatchObject({ state: 'IDLE', queue: [], paused: false })
      expect(coordinator.snapshot('channel-0')!.thread).toBeUndefined()

      const next = crypto.randomUUID()
      await coordinator.enqueue({ id: next, conversationId: 'channel-0', text: 'Count again', channelActor: { senderId: 'sender-new', topicId: 'canopy' } })
      const finished = await coordinator.waitForTurn('channel-0', next)
      expect(seen.get('channel-0')).toEqual([{ messages: 20, sender: 'sender-0' }, { messages: 21, sender: 'sender-new' }])
      expect(finished.thread).toMatchObject({ source: 'telegram', chatRef: 'fern-0', channelSenderId: 'sender-new', channelTopicId: 'canopy' })
      expect(finished.thread!.messages).toHaveLength(22)
      expect(holding(coordinator)).toHaveLength(4)
    } finally { await coordinator.close() }

    const restored = new SessionCoordinator(new AssistantRepository(data), { publish: () => {}, project: async () => {}, run })
    try {
      await restored.restore()
      expect(holding(restored)).toEqual([])
      expect((await restored.load('channel-5'))?.thread?.messages).toHaveLength(21)
    } finally { await restored.close() }
  }, 120000)
})
