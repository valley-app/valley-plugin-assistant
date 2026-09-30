import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import type { SessionSnapshot } from '../../src/contracts/execution'
import { ChannelReplyService } from '../../src/backend/channels/replies'
import { ChannelActions } from '../../src/backend/channels/actions'
import { ChannelBus } from '../../src/backend/channels/bus'
import { DeliveryQueue } from '../../src/backend/channels/deliveryQueue'
import { AssistantRepository, record } from '../../src/backend/persistence/repositories'
import { speechSchema } from '../../src/backend/configuration/schemas'
import { initBackend } from '../../src/backend/runtime'
import { datasetFixture } from '../backendDatasetFixture'

beforeEach(() => initBackend({} as PluginBackendApi))
function session(voiceInput = true): SessionSnapshot {
  return { conversationId: 'fern', revision: 1, state: 'IDLE', runId: null, streamingText: '', queue: [], paused: false, error: null, context: null, thread: {
    id: 'fern', title: 'Fern', createdAt: 1, updatedAt: 1, source: 'telegram', channelId: 'bot', chatRef: '123', channelSenderId: 'sender', channelTopicId: 'topic',
    messages: [{ id: 'input', role: 'user', content: 'Moss', voiceInput }, { id: 'output', role: 'assistant', content: 'A fern grows here.' }]
  } }
}
function fixture() {
  const repository = new AssistantRepository(datasetFixture()), queue = new DeliveryQueue(repository)
  const dispatch = vi.fn(async (input: Parameters<ChannelBus['send']>[0]) => [`remote:${input.id}`])
  const bus = { send: (input: Parameters<ChannelBus['send']>[0]) => queue.send(input, () => dispatch(input)) }
  const ports = {
    settings: vi.fn(async () => speechSchema.parse({ voiceId: 'voice' })),
    synthesize: vi.fn(async () => ({ handle: 'handle', name: 'reply.ogg', mimeType: 'audio/ogg' })),
    importFile: vi.fn(async () => ({ id: 'audio', path: 'media/audio', fileName: 'reply.ogg', kind: 'audio' as const, mime: 'audio/ogg' })),
    reference: vi.fn(async () => {}), release: vi.fn(async () => {})
  }
  return { repository, dispatch, ports, service: new ChannelReplyService(repository, bus, ports), bus }
}

describe('durable automatic channel replies', () => {
  it('synthesizes a voice reply once with a separate delivery identity and attachment reference', async () => {
    const { service, ports, dispatch } = fixture()
    const result = await service.deliver(session())
    await service.deliver(session())
    expect(result.errors).toEqual([])
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls.map(([input]) => input.id)).toEqual(['reply:fern:output', 'voice:fern:output:0'])
    expect(ports.synthesize).toHaveBeenCalledOnce()
    expect(ports.synthesize).toHaveBeenCalledWith(expect.objectContaining({ provider: 'elevenlabs', voice: 'voice', format: 'opus', text: 'A fern grows here.' }))
    expect(ports.importFile).toHaveBeenCalledWith({ fileHandle: 'handle', fileName: 'reply.ogg', mime: 'audio/ogg', kind: 'audio' })
    expect(ports.reference).toHaveBeenCalledWith('fern', 'audio')
    expect(ports.release).toHaveBeenCalledWith('handle')
  })
  it('does not synthesize for uploaded music, ordinary text, or disabled voice replies', async () => {
    const first = fixture(), value = session(false)
    value.thread!.messages[0].attachmentFiles = [{ fileName: 'music.mp3', path: 'music', kind: 'audio', metadata: { media: 'audio' } }]
    await first.service.deliver(value)
    expect(first.ports.synthesize).not.toHaveBeenCalled()
    const second = fixture()
    second.ports.settings.mockResolvedValue(speechSchema.parse({ voiceId: 'voice', replyWithVoice: false }))
    await second.service.deliver(session())
    expect(second.ports.synthesize).not.toHaveBeenCalled()
  })
  it('preserves delivered text and does not repeat potentially billed synthesis after a failure', async () => {
    const { service, ports, dispatch } = fixture()
    ports.importFile.mockRejectedValueOnce(new Error('Disk full'))
    const result = await service.deliver(session())
    await service.deliver(session())
    expect(result.errors.join(' ')).toContain('Automatic retry is blocked')
    expect(dispatch).toHaveBeenCalledOnce()
    expect(ports.synthesize).toHaveBeenCalledOnce()
    expect(ports.release).toHaveBeenCalledWith('handle')
  })
  it('marks interrupted synthesis unknown on restart without requesting more speech', async () => {
    const { service, ports, repository } = fixture()
    await service.deliver(session())
    const value = await repository.get<{ id: string; voice: Array<{ state: string }> }>('channel_replies', 'reply:fern:output')
    value!.voice[0].state = 'SYNTHESIZING'
    await repository.data.transaction([{ dataset: 'channel_replies', operation: 'upsert', values: record(value!.id, 'fern', 'READY', value) }])
    ports.synthesize.mockClear()
    await service.recover()
    const result = await service.deliver(session())
    expect(result.errors.join(' ')).toContain('billing outcome is unknown')
    expect(ports.synthesize).not.toHaveBeenCalled()
  })
  it('keeps the text response available when the linked speech settings are invalid', async () => {
    const { service, ports, dispatch } = fixture()
    ports.settings.mockRejectedValueOnce(new Error('Invalid Markdown'))
    const result = await service.deliver(session())
    expect(dispatch).toHaveBeenCalledOnce()
    expect(result.errors).toEqual(['Voice configuration is unavailable: Error: Invalid Markdown'])
  })
  it('binds persisted plan choices to the source sender and delivered message across repeated projections', async () => {
    const { service, repository, dispatch } = fixture(), value = session(false)
    value.thread!.plan = { id: 'plan', revision: 2, artifactHash: 'artifact', instructionSnapshotId: 'instructions', status: 'review', text: 'Plan' }
    await service.deliver(value)
    await service.deliver(value)
    expect(dispatch).toHaveBeenCalledTimes(2)
    const buttons = dispatch.mock.calls[1][0]
    expect(buttons.content.type).toBe('buttons')
    if (buttons.content.type !== 'buttons') throw new Error('Missing plan buttons')
    const actions = new ChannelActions(repository), run = vi.fn(async () => {})
    const actor = { channelId: 'bot', chatRef: '123', senderId: 'sender', messageId: `remote:${buttons.id}` }
    const choice = buttons.content.choices[0].value
    expect(await actions.consume(choice, { ...actor, messageId: 'another message' }, run)).toBe(false)
    expect(await actions.consume(choice, { ...actor, senderId: 'other sender' }, run)).toBe(false)
    expect(await actions.consume(choice, actor, run)).toBe(true)
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ kind: 'plan.approve', revision: 2, artifactHash: 'artifact', instructionSnapshotId: 'instructions' }), actor)
  })
  it('does not activate callbacks until their provider receipt is bound', async () => {
    const actions = new ChannelActions(new AssistantRepository(datasetFixture()))
    const actor = { channelId: 'bot', chatRef: '123', senderId: 'sender' }
    const handle = await actions.issue({ kind: 'plan.refine', conversationId: 'fern', planId: 'plan', revision: 1, artifactHash: 'a', instructionSnapshotId: 'i' }, actor, true)
    const run = vi.fn(async () => {})
    expect(await actions.consume(handle, { ...actor, messageId: 'm' }, run)).toBe(false)
    await actions.bindMessage(handle, 'm')
    expect(await actions.consume(handle, { ...actor, messageId: 'm' }, run)).toBe(true)
  })
})
