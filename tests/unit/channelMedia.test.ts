import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { initBackend } from '../../src/backend/runtime'
import { parseAttachment, parseUpdates } from '../../src/backend/channels/telegram'
import { parseWhatsAppLifecycle, parseWhatsAppWebhook } from '../../src/backend/channels/whatsapp'
import { formatChannelParts, formatTextParts, simplifyLatex } from '../../src/backend/channels/formatting'
import { validateContent } from '../../src/backend/channels/capabilities'
import { DeliveryQueue, DeliveryRejected } from '../../src/backend/channels/deliveryQueue'
import { ChannelActions } from '../../src/backend/channels/actions'
import { AssistantRepository } from '../../src/backend/persistence/repositories'
import { datasetFixture } from '../backendDatasetFixture'
import { stickerCapabilities, registerChannelTools } from '../../src/backend/channels/tools'
import { ToolRegistry } from '../../src/backend/tools/registry'
import type { ChannelBus } from '../../src/backend/channels/bus'
import type { ToolExecutionContext } from '../../src/contracts/tools'

beforeEach(() => initBackend({} as PluginBackendApi))

describe('channel content preservation and limits', () => {
  it('retains Telegram static, animated, video stickers and circular video metadata', () => {
    expect(parseAttachment({ sticker: { file_id: 'fern', file_unique_id: 'u', emoji: 'leaf', width: 512, height: 256 } })).toMatchObject({ fileName: 'fern.webp', metadata: { media: 'sticker', providerUniqueId: 'u', width: 512 } })
    expect(parseAttachment({ sticker: { file_id: 'fern', is_animated: true } })).toMatchObject({ fileName: 'fern.tgs', kind: 'file', metadata: { animated: true } })
    expect(parseAttachment({ sticker: { file_id: 'fern', is_video: true } })).toMatchObject({ fileName: 'fern.webm', metadata: { video: true } })
    expect(parseAttachment({ video_note: { file_id: 'moss', duration: 4 } })).toMatchObject({ metadata: { media: 'videoNote', duration: 4 } })
  })
  it('keeps reactions and edits separate from user turns', () => {
    const result = parseUpdates({ result: [{ update_id: 2, message_reaction: { chat: { id: 12 }, message_id: 5, new_reaction: [{ emoji: 'leaf' }] } }, { update_id: 3, edited_message: { chat: { id: 12 }, message_id: 6, text: 'fern' } }] })
    expect(result.messages).toEqual([])
    expect(result.lifecycle.map(value => value.type)).toEqual(['reaction', 'edited'])
  })
  it('retains provider chat types for ordinary messages and callbacks but does not invent them', () => {
    const result = parseUpdates({ result: [
      { update_id: 1, message: { text: 'Hello', chat: { id: 1, type: 'private' } } },
      { update_id: 2, callback_query: { data: 'choice', message: { chat: { id: 2, type: 'supergroup' } } } },
      { update_id: 3, message: { text: 'Hello', chat: { id: 3, type: 'unrecognized' } } }
    ] })
    expect(result.messages.map(message => message.chatType)).toEqual(['private', 'supergroup', undefined])
  })
  it('distinguishes WhatsApp audio from voice and keeps stickers and locations', () => {
    const payload = { entry: [{ changes: [{ value: { messages: [
      { from: '123', id: '1', type: 'audio', audio: { id: 'a', mime_type: 'audio/ogg', voice: true } },
      { from: '123', id: '2', type: 'audio', audio: { id: 'b', mime_type: 'audio/mpeg' } },
      { from: '123', id: '3', type: 'sticker', sticker: { id: 'c', mime_type: 'image/webp', animated: true } },
      { from: '123', id: '4', type: 'location', location: { latitude: 4, longitude: 5 } },
      { from: '123', id: '5', type: 'reaction', reaction: { message_id: '4', emoji: 'leaf' } }
    ], statuses: [{ id: 'out', recipient_id: '123', status: 'read', timestamp: '10' }] } }] }] }
    const incoming = parseWhatsAppWebhook(payload)
    expect(incoming).toHaveLength(4)
    expect(incoming.slice(0, 3).map(value => value.media?.[0].metadata.media)).toEqual(['voice', 'audio', 'sticker'])
    expect(incoming[3].location).toEqual({ latitude: 4, longitude: 5 })
    expect(parseWhatsAppLifecycle(payload).map(value => value.type)).toEqual(['receipt', 'reaction'])
  })
  it('uses operation limits instead of a universal media size', () => {
    const destination = { kind: 'whatsapp' as const, conversationId: 'moss' }
    expect(() => validateContent(destination, { type: 'attachment', media: 'image' }, { mime: 'image/png', bytes: 6 * 1024 * 1024 })).toThrow('limit')
    expect(() => validateContent(destination, { type: 'attachment', media: 'sticker' }, { mime: 'image/webp', bytes: 101 * 1024 })).toThrow('limit')
    expect(() => validateContent(destination, { type: 'attachment', media: 'sticker', metadata: { media: 'sticker', animated: true } }, { mime: 'image/webp', bytes: 101 * 1024 })).not.toThrow()
    expect(() => validateContent(destination, { type: 'attachment', media: 'file' }, { mime: 'application/pdf', bytes: 60 * 1024 * 1024 }, 100 * 1024 * 1024)).not.toThrow()
    expect(() => validateContent(destination, { type: 'list', text: 'Choose', button: 'Choose', sections: [{ title: 'Moss', rows: Array.from({ length: 11 }, (_, index) => ({ id: String(index), title: 'Moss' })) }] })).toThrow('1–10')
  })
  it('keeps sticker sending independent of unavailable vision or animation decoding', () => {
    expect(stickerCapabilities({ mime: 'application/x-tgsticker', visionAvailable: true })).toMatchObject({ receive: true, preserveOriginal: true, preview: false, interpret: false, send: { telegram: true, whatsapp: false } })
    expect(stickerCapabilities({ mime: 'image/webp', visionAvailable: false })).toMatchObject({ preview: true, interpret: false, send: { telegram: true, whatsapp: true } })
    expect(stickerCapabilities({ mime: 'image/webp', visionAvailable: true })).toMatchObject({ preview: true, interpret: true })
  })
  it('blocks channel tools in plan mode even if invoked outside the executor', async () => {
    const registry = new ToolRegistry(), send = vi.fn()
    registerChannelTools(registry, { send } as unknown as ChannelBus, { destination: { kind: 'telegram', conversationId: 'fern', chatRef: 'fern' }, planning: true })
    expect(registry.descriptors(new Set(), true).map(value => value.name)).not.toContain('channel_send')
    await expect(registry.get('channel_send')!.execute({ deliveryKey: 'send', content: { type: 'text', text: 'moss' } }, { planning: false } as ToolExecutionContext)).rejects.toThrow('Plan mode')
    expect(send).not.toHaveBeenCalled()
  })
  it('requires core authorization before remote sends and stops on denial', async () => {
    const registry = new ToolRegistry(), send = vi.fn(), authorizeExternal = vi.fn(async () => { throw new Error('Guard denied') })
    const destination = { kind: 'telegram' as const, conversationId: 'fern', chatRef: 'fern' }
    registerChannelTools(registry, { send } as unknown as ChannelBus, { destination, planning: false, authorizeExternal })
    const context = { planning: false, conversationId: 'fern', operation: { cancellation: { throwIfAborted() {} } } } as ToolExecutionContext
    const content = { type: 'text', text: 'moss' }
    await expect(registry.get('channel_send')!.execute({ deliveryKey: 'send', content }, context)).rejects.toThrow('Guard denied')
    expect(authorizeExternal).toHaveBeenCalledWith(context, { destination, content })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('mobile formatting', () => {
  it('preserves grouped math, matrices, unknown commands, and code literally', () => {
    expect(simplifyLatex('\\frac{1}{\\sqrt{x^2}}')).toBe('(1 / √(x²))')
    expect(simplifyLatex('\\begin{matrix}a & b\\\\c & d\\end{matrix}')).toBe('[a, b; c, d]')
    expect(simplifyLatex('\\unknown{x}')).toBe('\\unknown(x)')
    expect(formatTextParts('```js\nconst x = "$\\frac{a}{b}$"\n```', 'whatsapp')[0].text).toContain('$\\frac{a}{b}$')
    expect(formatTextParts('$\\frac{a}{b}$ and **fern**', 'whatsapp')[0].text).toBe('(a / b) and *fern*')
  })
  it('splits long code and Unicode without broken Telegram HTML or data loss', () => {
    const code = '<ö>'.repeat(4000)
    const parts = formatTextParts(`\`\`\`\n${code}\n\`\`\``, 'telegram')
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every(part => part.text.length <= 4096 && part.text.startsWith('<pre>') && part.text.endsWith('</pre>'))).toBe(true)
    expect(parts.map(part => part.text.slice(5, -6).replace(/&lt;/g, '<').replace(/&gt;/g, '>')).join('')).toBe(code)
  })
  it('separates noncaption media from its formatted companion text', () => {
    const parts = formatChannelParts({ type: 'attachment', attachmentId: 'fern', media: 'voice', caption: '**Fern**' }, 'whatsapp')
    expect(parts).toMatchObject([{ type: 'text', text: '*Fern*' }, { type: 'attachment', caption: undefined }])
  })
})

describe('durable delivery parts and action handles', () => {
  it('retries only failed parts with exact persisted formatting', async () => {
    const queue = new DeliveryQueue(new AssistantRepository(datasetFixture()))
    const input = { id: 'reply', destination: { kind: 'telegram' as const, conversationId: 'moss' }, content: { type: 'text' as const, text: 'original' } }
    const parts = [{ type: 'text' as const, text: '<b>fern</b>', format: 'telegramHtml' as const }, { type: 'text' as const, text: 'moss' }]
    const first = vi.fn().mockResolvedValueOnce(['a']).mockRejectedValueOnce(new DeliveryRejected('rejected'))
    expect((await queue.sendParts(input, parts, first)).state).toBe('FAILED')
    const retry = vi.fn(async () => ['b'])
    const result = await queue.sendParts(input, [{ type: 'text', text: 'changed formatter output' }], retry, true)
    expect(retry).toHaveBeenCalledOnce(); expect(retry).toHaveBeenCalledWith(parts[1])
    expect(result.providerMessageIds).toEqual(['a', 'b'])
  })
  it('does not replay unknown sends and does not downgrade read receipts', async () => {
    const repository = new AssistantRepository(datasetFixture()), queue = new DeliveryQueue(repository)
    const input = { id: 'reply', destination: { kind: 'whatsapp' as const, conversationId: 'moss', channelId: 'bot' }, content: { type: 'text' as const, text: 'fern' } }
    await queue.send(input, async () => { throw new Error('connection lost') })
    const retry = vi.fn(async () => ['b'])
    expect((await queue.sendParts(input, [input.content], retry, true)).state).toBe('UNKNOWN')
    expect(retry).not.toHaveBeenCalled()
    await queue.send({ ...input, id: 'read' }, async () => ['c'])
    await queue.providerReceipt('bot', 'c', 'READ'); await queue.providerReceipt('bot', 'c', 'DELIVERED')
    expect((await repository.get<{ state: string }>('outbound_deliveries', 'read'))?.state).toBe('READ')
  })
  it('binds action callbacks to the authorized actor and consumes once', async () => {
    const actions = new ChannelActions(new AssistantRepository(datasetFixture()))
    const actor = { channelId: 'bot', chatRef: 'moss', senderId: 'fern', messageId: 'm1' }
    const id = await actions.issue({ kind: 'plan.approve', conversationId: 'moss', planId: 'plan', revision: 1, artifactHash: 'hash', instructionSnapshotId: 'snapshot' }, actor)
    const run = vi.fn(async () => {})
    expect(await actions.consume(id, { ...actor, senderId: 'oak' }, run)).toBe(false)
    expect(await actions.consume(id, actor, run)).toBe(true)
    expect(await actions.consume(id, actor, run)).toBe(false)
    expect(run).toHaveBeenCalledOnce()
  })
  it('does not downgrade a partly read response when a stale failure arrives', async () => {
    const repository = new AssistantRepository(datasetFixture()), queue = new DeliveryQueue(repository)
    const input = { id: 'reply', destination: { kind: 'whatsapp' as const, conversationId: 'moss', channelId: 'bot' }, content: { type: 'text' as const, text: 'fern' } }
    await queue.sendParts(input, [input.content, { type: 'text', text: 'moss' }], vi.fn().mockResolvedValueOnce(['a']).mockResolvedValueOnce(['b']))
    await queue.providerReceipt('bot', 'a', 'READ')
    await queue.providerReceipt('bot', 'a', 'FAILED', 'stale failure')
    expect((await repository.get<{ state: string }>('outbound_deliveries', 'reply'))?.state).toBe('ACCEPTED')
    await queue.providerReceipt('bot', 'b', 'DELIVERED')
    expect((await repository.get<{ state: string }>('outbound_deliveries', 'reply'))?.state).toBe('DELIVERED')
  })
})
