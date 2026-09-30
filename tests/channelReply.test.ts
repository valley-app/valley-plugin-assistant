import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiChatThread } from '../src/types'
import { channelFixture, createBackendChannelFixture } from './backendChannelFixture'
import { DeliveryRejected, type OutboundDelivery } from '../src/backend/channels/deliveryQueue'
import { createMockValleyApi } from './mock'
import { getStore, disposeStore } from '../src/store'

const until = async (predicate: () => boolean) => vi.waitFor(() => expect(predicate()).toBe(true))
const mirror = (): AiChatThread => ({ id: 'tg-telegram-123', title: 'Field notes', createdAt: 1, updatedAt: 1, source: 'telegram', channelId: 'telegram', chatRef: '123', messages: [{ role: 'user', content: 'hello?' }] })

describe('backend-owned manual channel replies', () => {
  it('sends once and appends an accepted manual reply without running the model', async () => {
    const thread = mirror()
    channelFixture.threads.set(thread.id, thread)
    const { runtime } = createBackendChannelFixture()
    const input = { id: 'request', conversationId: thread.id, text: 'On my way' }
    await runtime.sendAsChannel(input)
    await runtime.sendAsChannel(input)
    expect(channelFixture.dispatch).toHaveBeenCalledOnce()
    expect(channelFixture.infer).not.toHaveBeenCalled()
    expect(channelFixture.threads.get(thread.id)?.messages.filter(message => message.content === input.text)).toHaveLength(1)
    expect(channelFixture.threads.get(thread.id)?.messages.at(-1)).toMatchObject({ role: 'assistant', channelDeliveryId: 'manual:tg-telegram-123:request', content: input.text })
  })

  it('keeps a confirmed failed send out of the transcript and retains its retryable receipt', async () => {
    const thread = mirror()
    channelFixture.threads.set(thread.id, thread)
    const { runtime } = createBackendChannelFixture()
    channelFixture.dispatch.mockRejectedValueOnce(new DeliveryRejected('Chat not found'))
    await expect(runtime.sendAsChannel({ id: 'failed', conversationId: thread.id, text: 'Canopy update' })).rejects.toThrow('Chat not found')
    expect(channelFixture.threads.get(thread.id)?.messages).toHaveLength(1)
    expect(await runtime.repository.get('outbound_deliveries', 'manual:tg-telegram-123:failed')).toMatchObject({ state: 'FAILED', error: expect.stringContaining('Chat not found') })
    expect(channelFixture.infer).not.toHaveBeenCalled()
  })

  it('does not replay a send whose provider outcome is unknown', async () => {
    const thread = mirror()
    channelFixture.threads.set(thread.id, thread)
    const { runtime } = createBackendChannelFixture()
    channelFixture.dispatch.mockRejectedValueOnce(new Error('Connection lost after upload'))
    const input = { id: 'uncertain', conversationId: thread.id, text: 'Canopy update' }
    await expect(runtime.sendAsChannel(input)).rejects.toThrow('Connection lost')
    await expect(runtime.sendAsChannel(input)).rejects.toThrow('Connection lost')
    expect(channelFixture.dispatch).toHaveBeenCalledOnce()
    expect(channelFixture.threads.get(thread.id)?.messages).toHaveLength(1)
    expect((await runtime.repository.get<OutboundDelivery>('outbound_deliveries', 'manual:tg-telegram-123:uncertain'))?.state).toBe('UNKNOWN')
  })

  it('recovers an accepted send after a crash before its transcript append without resending', async () => {
    const thread = mirror()
    channelFixture.threads.set(thread.id, thread)
    const { runtime, data } = createBackendChannelFixture()
    vi.spyOn(runtime.coordinator, 'change').mockRejectedValueOnce(new Error('Crash before append'))
    await expect(runtime.sendAsChannel({ id: 'request', conversationId: thread.id, text: 'On my way' })).rejects.toThrow('Crash before append')
    expect(channelFixture.threads.get(thread.id)?.messages).toHaveLength(1)
    await runtime.close()
    const restored = createBackendChannelFixture(data).runtime
    await restored.restore()
    expect(channelFixture.dispatch).toHaveBeenCalledOnce()
    expect(channelFixture.infer).not.toHaveBeenCalled()
    expect(channelFixture.threads.get(thread.id)?.messages.at(-1)).toMatchObject({ channelDeliveryId: 'manual:tg-telegram-123:request', content: 'On my way' })
  })

  it('does not restore deleted conversations from accepted manual delivery records', async () => {
    const thread = mirror()
    channelFixture.threads.set(thread.id, thread)
    const { runtime, data } = createBackendChannelFixture()
    await runtime.sendAsChannel({ id: 'request', conversationId: thread.id, text: 'On my way' })
    await runtime.coordinator.remove(thread.id)
    channelFixture.threads.delete(thread.id)
    await runtime.close()
    const restored = createBackendChannelFixture(data).runtime
    await restored.restore()
    expect(restored.coordinator.snapshot(thread.id)).toBeNull()
    expect(channelFixture.threads.has(thread.id)).toBe(false)
    expect(channelFixture.dispatch).toHaveBeenCalledOnce()
  })

  it('rejects empty messages and local conversations before remote dispatch', async () => {
    const thread = mirror()
    channelFixture.threads.set(thread.id, thread)
    const { runtime } = createBackendChannelFixture()
    await expect(runtime.sendAsChannel({ id: 'empty', conversationId: thread.id, text: '' })).rejects.toThrow()
    channelFixture.threads.set('local', { id: 'local', title: 'Local', createdAt: 1, updatedAt: 1, messages: [] })
    await expect(runtime.sendAsChannel({ id: 'local', conversationId: 'local', text: 'Hello' })).rejects.toThrow('no channel destination')
    expect(channelFixture.dispatch).not.toHaveBeenCalled()
  })
})

describe('assistant store — defaults for new chats', () => {
  afterEach(() => disposeStore())
  it('seeds a new chat from the Chat settings personality and model', async () => {
    const mock = createMockValleyApi({
      settings: { defaultProfileId: 'coach', defaultModel: 'research:claude-opus-4-8' }
    })
    const config = await mock.api.assistant.getConfig()
    if (!config.ok || !config.data) throw new Error('Missing test assistant configuration')
    config.data.connections.push({
      id: 'research', provider: 'anthropic', createdAt: 1,
      providerName: 'Anthropic', providerDescription: '', providerIcon: '',
      providerCapabilities: [], requiresKey: true, baseUrl: 'https://api.anthropic.com',
      configured: true, models: []
    })
    const store = getStore(mock.api)
    await until(() => Boolean(store.getSnapshot().active))

    store.newChat()
    const active = store.getSnapshot().active
    expect(active?.profileId).toBe('coach')
    expect(active?.model).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8', connectionId: 'research' })
  })

  it('leaves a new chat on Auto and the default personality when nothing is set', async () => {
    const mock = createMockValleyApi()
    const store = getStore(mock.api)
    await until(() => Boolean(store.getSnapshot().active))

    store.newChat()
    const active = store.getSnapshot().active
    expect(active?.profileId).toBeUndefined()
    expect(active?.model).toBeNull()
  })
})
