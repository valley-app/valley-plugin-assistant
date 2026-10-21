import { describe, expect, it, vi } from 'vitest'
import type { DatasetTransactionOperation } from '@valley/plugin-sdk/datasets'
import { channelFixture, createBackendChannelFixture } from './backendChannelFixture'
import type { AiChatThread } from '../src/types'
import type { SessionEvent, SessionSnapshot } from '../src/contracts/execution'

// About 1 MB, like the largest stored conversations, among 150 chats.
const large = (id: string): AiChatThread => ({ id, title: 'Moss transect', createdAt: 1, updatedAt: 1, messages: Array.from({ length: 40 }, (_, index) => ({ id: `${id}-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const, content: `Moss transect note ${index} `.padEnd(24000, 'lichen ') })) })

describe('streaming updates of a large conversation', () => {
  it('publishes streaming text without the unchanged messages and saves one waiting update while a slow save runs', async () => {
    const { runtime, emit, data } = createBackendChannelFixture()
    for (let index = 0; index < 149; index++) channelFixture.threads.set(`fern-${index}`, { id: `fern-${index}`, title: `Fern ${index}`, createdAt: 1, updatedAt: 1, messages: [] })
    const thread = large('moss')
    channelFixture.threads.set(thread.id, structuredClone(thread))
    // Each save of the whole conversation takes 300 ms, as on a busy host; streaming text arrives every 110 ms.
    const transaction = data.transaction.bind(data), saves: Array<{ type: string; row: SessionSnapshot }> = []
    const values = (operation: DatasetTransactionOperation | undefined) => (operation as { values?: Record<string, unknown> } | undefined)?.values
    data.transaction = (async (operations: DatasetTransactionOperation[]) => {
      const row = values(operations.find(operation => operation.dataset === 'sessions' && operation.operation === 'upsert'))
      const event = values(operations.find(operation => operation.dataset === 'session_events'))
      if (row && event) {
        saves.push({ type: String(event.state), row: structuredClone(row.payload) as SessionSnapshot })
        await new Promise(resolve => setTimeout(resolve, 300))
      }
      return transaction(operations)
    }) as typeof data.transaction
    const texts = Array.from({ length: 30 }, (_, index) => `Moss covers ${index + 1} plots`)
    channelFixture.infer.mockImplementationOnce(async (_input: unknown, _context: unknown, hooks: { event(value: unknown): void }) => {
      for (const text of texts) { hooks.event({ type: 'text', text }); await new Promise(resolve => setTimeout(resolve, 110)) }
      hooks.event({ type: 'message', message: { role: 'assistant', content: `${texts.at(-1)}.` } })
    })
    await runtime.submit({ id: 'stream-turn', conversationId: thread.id, text: 'Count the moss plots', thread })
    await vi.waitFor(() => expect(runtime.coordinator.snapshot(thread.id)?.state).toBe('IDLE'), { timeout: 30000, interval: 50 })
    await vi.waitFor(() => expect(channelFixture.threads.get(thread.id)?.messages.at(-1)?.content).toBe(`${texts.at(-1)}.`))

    const published = emit.mock.calls.filter(([name]) => name === 'session.changed').map(([, value]) => value as { session: SessionSnapshot; event: SessionEvent })
    const streamed = published.filter(value => value.event.type === 'stream')
    expect(streamed.length).toBeGreaterThan(1)
    for (const value of streamed) {
      expect(value.session.thread).toBeUndefined()
      expect(JSON.stringify(value).length).toBeLessThan(4096)
    }
    expect(streamed.at(-1)!.session.streamingText).toBe(texts.at(-1))
    expect(published.filter(value => value.event.type !== 'stream').every(value => value.session.thread?.messages.length)).toBe(true)
    expect(published.at(-1)!.session).toMatchObject({ state: 'IDLE', streamingText: '' })
    expect(published.at(-1)!.session.thread!.messages.slice(-2).map(message => message.content)).toEqual(['Count the moss plots', `${texts.at(-1)}.`])

    // Every save still writes the whole conversation; streaming updates that waited behind a slow save were merged into one.
    const streamSaves = saves.filter(save => save.type === 'stream')
    expect(streamSaves.length).toBeGreaterThan(1)
    expect(streamSaves.length).toBeLessThanOrEqual(14)
    expect(streamSaves.map(save => save.row.streamingText)).toEqual([...new Set(streamSaves.map(save => save.row.streamingText))])
    expect(streamSaves.at(-1)!.row.streamingText).toBe(texts.at(-1))
    for (const save of saves) expect(save.row.thread!.messages.length).toBeGreaterThanOrEqual(40)
    const stored = await runtime.repository.get<SessionSnapshot>('sessions', thread.id), live = runtime.coordinator.snapshot(thread.id)!
    expect(stored).toMatchObject({ state: 'IDLE', streamingText: '', queue: [], revision: live.revision })
    expect(stored!.thread!.messages).toEqual(live.thread!.messages)
  }, 40000)
})
