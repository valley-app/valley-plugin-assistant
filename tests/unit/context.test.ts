import { describe, expect, it, vi } from 'vitest'
import { ContextEngine } from '../../src/backend/context/compactor'
import { contextUsage } from '../../src/backend/context/tokenMeter'
import { AssistantRepository } from '../../src/backend/persistence/repositories'
import { datasetFixture } from '../backendDatasetFixture'
import type { AiChatRequest } from '../../src/types'

const request = (): AiChatRequest => ({ requestId: 'request', conversationId: 'moss', provider: 'fixture', model: 'forest', messages: [{ role: 'system', content: 'Preserve every specimen.' }, ...Array.from({ length: 8 }, (_, index) => [{ role: 'user' as const, content: `Inspect fern ${index}` }, { role: 'assistant' as const, content: 'Fern characteristics '.repeat(30) }]).flat()] })
describe('context compaction', () => {
  it('keeps model capacity unknown and labels estimates', () => {
    expect(contextUsage(request(), null)).toMatchObject({ capacity: null, estimated: true, availableTokens: null })
    expect(contextUsage(request(), 10000, 400)).toMatchObject({ inputTokens: 400, reservedTokens: 2000, estimated: false, availableTokens: 7600 })
  })
  it('compacts only older complete turns without changing visible messages', async () => {
    const repository = new AssistantRepository(datasetFixture()), original = request(), before = structuredClone(original)
    const summary = vi.fn(async () => 'Keep the specimen inventory and inspect the remaining ferns.')
    const engine = new ContextEngine(repository, summary)
    const result = await engine.prepare(original, 10000, true)
    expect(original).toEqual(before)
    expect(result.request.messages.slice(-8)).toEqual(before.messages.slice(-8))
    expect(result.request.messages[0]).toEqual(before.messages[0])
    expect(await repository.get('context_checkpoints', 'moss')).toMatchObject({ messageCount: 8 })
    await engine.prepare(original, 10000)
    expect(summary).toHaveBeenCalledTimes(1)
  })
  it('preserves the previous checkpoint when summarization fails or is cancelled', async () => {
    const repository = new AssistantRepository(datasetFixture()), engine = new ContextEngine(repository, async () => { throw new Error('Provider unavailable') })
    await expect(engine.prepare(request(), 10000, true)).rejects.toThrow('Provider unavailable')
    expect(await repository.get('context_checkpoints', 'moss')).toBeNull()
    const cancellation = new AbortController(); cancellation.abort()
    await expect(engine.prepare(request(), 10000, true, cancellation.signal)).rejects.toThrow()
    expect(await repository.get('context_checkpoints', 'moss')).toBeNull()
  })
})
