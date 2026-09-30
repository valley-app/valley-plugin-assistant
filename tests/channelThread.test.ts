import { describe, expect, it, vi } from 'vitest'
import { channelFixture, createBackendChannelFixture } from './backendChannelFixture'
import { DeliveryRejected, type OutboundDelivery } from '../src/backend/channels/deliveryQueue'
import type { AiChatThread, ChannelMessage } from '../src/types'

const incoming = (patch: Partial<ChannelMessage> = {}): ChannelMessage => ({ channelId: 'telegram', chatRef: '123', senderId: 'sender', providerEventId: 'event-1', providerMessageId: 'message-1', from: 'Fern', text: 'hi', ts: Date.now(), ...patch })
const settled = async (runtime: ReturnType<typeof createBackendChannelFixture>['runtime'], id: string) => {
  await vi.waitFor(() => expect(runtime.coordinator.snapshot(id)?.state).toBe('IDLE'))
  await vi.waitFor(() => expect(channelFixture.threads.get(id)?.messages.at(-1)?.role).toBe('assistant'))
}

describe('backend-owned remote conversations', () => {
  it('runs and persists an incoming Telegram conversation without a renderer listener', async () => {
    const local: AiChatThread = { id: 'local', title: 'Local chat', createdAt: 1, updatedAt: 1, messages: [] }
    channelFixture.threads.set(local.id, structuredClone(local))
    const { runtime, emit } = createBackendChannelFixture()
    const accepted = await runtime.inbound('telegram', incoming())
    await settled(runtime, accepted.conversationId)
    await vi.waitFor(() => expect(channelFixture.dispatch).toHaveBeenCalledOnce())
    expect(channelFixture.threads.get('local')).toEqual(local)
    expect(channelFixture.threads.get(accepted.conversationId)).toMatchObject({ source: 'telegram', channelId: 'telegram', chatRef: '123', channelName: 'Field bot', channelSenderId: 'sender', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Reply from agent.' }] })
    expect(channelFixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ kind: 'telegram', channelId: 'telegram', chatRef: '123', conversationId: accepted.conversationId }), expect.objectContaining({ type: 'text', text: 'Reply from agent.' }), undefined)
    expect(emit).toHaveBeenCalledWith('session.changed', expect.objectContaining({ session: expect.objectContaining({ conversationId: accepted.conversationId }) }))
  })

  it('uses the WhatsApp destination and durable inbound receipt to open its support window', async () => {
    const { runtime } = createBackendChannelFixture()
    const message = incoming({ channelId: 'whatsapp-1', chatRef: '15550100001', text: 'hello', providerEventId: 'wa1' })
    const accepted = await runtime.inbound('whatsapp-1', message)
    await settled(runtime, accepted.conversationId)
    await vi.waitFor(() => expect(channelFixture.dispatch).toHaveBeenCalledOnce())
    expect(channelFixture.threads.get(accepted.conversationId)).toMatchObject({ source: 'whatsapp', channelId: 'whatsapp-1', chatRef: '15550100001', channelName: 'Fungi channel' })
    expect(await runtime.repository.get('inbound_receipts', 'inbound:whatsapp-1:wa1')).toMatchObject({ receivedAt: message.ts, providerMessageId: 'message-1' })
    expect(channelFixture.dispatch.mock.calls[0][0]).toMatchObject({ kind: 'whatsapp', chatRef: '15550100001' })
  })

  it('deduplicates provider redelivery across backend restarts without another inference or send', async () => {
    const { runtime, data } = createBackendChannelFixture(), message = incoming()
    const accepted = await runtime.inbound('telegram', message)
    await settled(runtime, accepted.conversationId)
    await vi.waitFor(() => expect(channelFixture.dispatch).toHaveBeenCalledOnce())
    await runtime.close()
    const restored = createBackendChannelFixture(data).runtime
    await restored.restore()
    await restored.inbound('telegram', message)
    expect(channelFixture.infer).toHaveBeenCalledOnce()
    expect(channelFixture.dispatch).toHaveBeenCalledOnce()
    expect(restored.coordinator.snapshot(accepted.conversationId)?.thread?.messages).toHaveLength(2)
  })

  it('keeps existing remote conversation identity and history when upgrading', async () => {
    channelFixture.threads.set('tg-telegram-123', { id: 'tg-telegram-123', title: 'Renamed history', createdAt: 1, updatedAt: 1, source: 'telegram', channelId: 'telegram', chatRef: '123', messages: [{ id: 'old', role: 'user', content: 'Earlier context' }] })
    const { runtime } = createBackendChannelFixture()
    const accepted = await runtime.inbound('telegram', incoming())
    await settled(runtime, accepted.conversationId)
    expect(accepted.conversationId).toBe('tg-telegram-123')
    expect(channelFixture.threads.get(accepted.conversationId)).toMatchObject({ title: 'Renamed history', messages: [{ id: 'old', content: 'Earlier context' }, { content: 'hi' }, { content: 'Reply from agent.' }] })
  })

  it('isolates forum topics even when their chat IDs match', async () => {
    const { runtime } = createBackendChannelFixture()
    const first = await runtime.inbound('telegram', incoming({ topicId: 'topic-1' }))
    const second = await runtime.inbound('telegram', incoming({ topicId: 'topic-2', providerEventId: 'event-2' }))
    await settled(runtime, first.conversationId); await settled(runtime, second.conversationId)
    expect(first.conversationId).not.toBe(second.conversationId)
    expect(channelFixture.threads.get(first.conversationId)?.channelTopicId).toBe('topic-1')
    expect(channelFixture.threads.get(second.conversationId)?.channelTopicId).toBe('topic-2')
  })

  it('stores delivery failure separately from the completed response and retries without inference', async () => {
    const { runtime, emit } = createBackendChannelFixture()
    channelFixture.dispatch.mockRejectedValueOnce(new DeliveryRejected('Transport unavailable'))
    const accepted = await runtime.inbound('telegram', incoming())
    await settled(runtime, accepted.conversationId)
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('delivery.error', expect.objectContaining({ conversationId: accepted.conversationId, error: expect.stringContaining('Transport unavailable') })))
    const deliveries = await runtime.repository.rows<OutboundDelivery>('outbound_deliveries')
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({ state: 'FAILED', content: { text: 'Reply from agent.' } })
    expect(channelFixture.threads.get(accepted.conversationId)?.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Reply from agent.' })
    expect(channelFixture.threads.get(accepted.conversationId)?.messages.at(-1)?.error).toBeUndefined()
    await runtime.channels.retry(deliveries[0].id, accepted.conversationId)
    expect(channelFixture.infer).toHaveBeenCalledOnce()
    expect(channelFixture.dispatch).toHaveBeenCalledTimes(2)
  })
})
