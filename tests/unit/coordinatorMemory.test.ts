import v8 from 'node:v8'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { SessionCoordinator } from '../../src/backend/engine/coordinator'
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
})
