import './backendFileFixture'
import { describe, expect, it, vi } from 'vitest'
import { channelManager } from '../src/backend/channels/manager'
import { AssistantRepository } from '../src/backend/persistence/repositories'
import { datasetFixture } from './backendDatasetFixture'
import type { ChannelInboundMessage } from '../src/backend/channels/types'

describe('a channel message rejected before it reaches a conversation', () => {
  it('tells the sender in a plain reply on Telegram and WhatsApp, and never answers a sender who is not allowed', async () => {
    const repository = new AssistantRepository(datasetFixture())
    const config = { bot: { type: 'telegram', name: 'Field bot', allowFrom: ['fern'], enabled: true }, wa: { type: 'whatsapp', name: 'Field phone', allowFrom: ['moss'], enabled: true, phoneNumberId: 'phone' } }
    const manager = channelManager as unknown as { readConfig: () => Promise<typeof config>; mediaQueue: { accept(id: string, message: ChannelInboundMessage): Promise<void> } }
    vi.spyOn(manager, 'readConfig').mockResolvedValue(config)
    const dispatch = vi.spyOn(channelManager, 'dispatch').mockResolvedValue(['sent'])
    const onInbound = vi.fn(async () => { throw new Error('Assistant is stopping') })
    channelManager.bindRuntime({ repository, onInbound, onLifecycle: async () => {} })

    await manager.mediaQueue.accept('bot', { providerEventId: '1', providerMessageId: '41', chatRef: 'fern', senderId: 'fern', topicId: '7', chatType: 'supergroup', text: 'Water the ferns' })
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    expect(dispatch).toHaveBeenCalledWith(
      { kind: 'telegram', conversationId: 'channel:bot:fern', channelId: 'bot', chatRef: 'fern', topicId: '7', chatType: 'supergroup', replyToMessageId: '41' },
      { type: 'text', text: 'This message failed and was not processed: Assistant is stopping', format: 'plain' })

    await manager.mediaQueue.accept('wa', { providerEventId: '2', providerMessageId: 'wamid.2', chatRef: 'moss', senderId: 'moss', chatType: 'private', text: 'Check the moss' })
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
    expect(dispatch.mock.calls[1]).toEqual([
      { kind: 'whatsapp', conversationId: 'channel:wa:moss', channelId: 'wa', chatRef: 'moss', topicId: undefined, chatType: 'private', replyToMessageId: 'wamid.2' },
      { type: 'text', text: 'This message failed and was not processed: Assistant is stopping', format: 'plain' }])

    // A sender who is not allowed is rejected before onInbound; the reply goes through dispatch, which only reaches allowed recipients.
    dispatch.mockRestore()
    const rejected = vi.spyOn(channelManager, 'dispatch')
    await manager.mediaQueue.accept('bot', { providerEventId: '3', providerMessageId: '43', chatRef: 'stranger', senderId: 'stranger', text: 'hello' })
    await vi.waitFor(() => expect(rejected).toHaveBeenCalledOnce())
    await expect(rejected.mock.results[0].value).rejects.toThrow('Destination is not explicitly allowed for this connection')
    expect(onInbound).toHaveBeenCalledTimes(2)
  })
})
