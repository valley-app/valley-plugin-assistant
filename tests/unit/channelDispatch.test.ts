import type { PluginBackendApi } from '@valley/plugin-sdk'
import { initBackend } from '../../src/backend/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchTelegram } from '../../src/backend/channels/adapters/telegram'
import { dispatchWhatsApp } from '../../src/backend/channels/adapters/whatsapp'

const transport = vi.hoisted(() => ({ telegram: vi.fn(), whatsapp: vi.fn(), upload: vi.fn() }))
vi.mock('../../src/backend/channels/network', () => ({ telegramFetch: transport.telegram, whatsappFetch: transport.whatsapp, uploadFile: transport.upload }))
beforeEach(() => {
  initBackend({} as PluginBackendApi)
  transport.telegram.mockReset().mockImplementation(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 3 } })))
  transport.whatsapp.mockReset().mockImplementation(async () => new Response(JSON.stringify({ messages: [{ id: 'out' }] })))
  transport.upload.mockReset()
})
const telegram = { kind: 'telegram' as const, channelId: 'bot', conversationId: 'fern', chatRef: '123', chatType: 'private' as const }
const whatsapp = { ...telegram, kind: 'whatsapp' as const }

describe('typed channel adapter dispatch', () => {
  it('sends a sticker as a sticker and a circular video through its own endpoint', async () => {
    transport.upload.mockImplementation(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 3 } })))
    await dispatchTelegram('opaque', telegram, { type: 'attachment', media: 'sticker', attachmentId: 'fern' }, { path: '/vault/fern', fileName: 'fern.webp', mime: 'image/webp' })
    expect(transport.upload.mock.calls[0][0]).toContain('/sendSticker')
    expect(transport.upload.mock.calls[0][4]).toBe('sticker')
    await dispatchTelegram('opaque', telegram, { type: 'attachment', media: 'videoNote', attachmentId: 'fern' }, { path: '/vault/fern', fileName: 'fern.mp4', mime: 'video/mp4' })
    expect(transport.upload.mock.calls[1][0]).toContain('/sendVideoNote')
  })
  it('sends Telegram venues, pin actions and URL keyboards without inference turns', async () => {
    await dispatchTelegram('opaque', telegram, { type: 'location', latitude: 3, longitude: 4, name: 'Forest', address: 'Trail' })
    expect(transport.telegram.mock.calls[0][0]).toContain('/sendVenue')
    await dispatchTelegram('opaque', telegram, { type: 'pin', messageId: '2' })
    expect(transport.telegram.mock.calls[1][0]).toContain('/pinChatMessage')
    await dispatchTelegram('opaque', telegram, { type: 'keyboard', text: 'Open', rows: [[{ label: 'Open', url: 'https://example.org' }]] })
    expect(JSON.parse(transport.telegram.mock.calls[2][1].body).reply_markup.inline_keyboard[0][0]).toEqual({ text: 'Open', url: 'https://example.org' })
  })
  it('sends WhatsApp stickers without captions, CTA and read receipts', async () => {
    transport.upload.mockImplementation(async () => new Response(JSON.stringify({ id: 'media' })))
    await dispatchWhatsApp('opaque', { type: 'whatsapp', phoneNumberId: 'number' }, whatsapp, { type: 'attachment', media: 'sticker', attachmentId: 'fern' }, { path: '/vault/fern', fileName: 'fern.webp', mime: 'image/webp' })
    expect(JSON.parse(transport.whatsapp.mock.calls[0][1].body)).toMatchObject({ type: 'sticker', sticker: { id: 'media' } })
    await dispatchWhatsApp('opaque', { type: 'whatsapp', phoneNumberId: 'number' }, whatsapp, { type: 'cta', text: 'Open', label: 'Open', url: 'https://example.org' })
    expect(JSON.parse(transport.whatsapp.mock.calls[1][1].body).interactive.type).toBe('cta_url')
    transport.whatsapp.mockImplementationOnce(async () => new Response(JSON.stringify({ success: true })))
    expect(await dispatchWhatsApp('opaque', { type: 'whatsapp', phoneNumberId: 'number' }, whatsapp, { type: 'read', messageId: 'incoming' })).toEqual([])
  })
  it('rejects unsupported operations before any network side effects', async () => {
    await expect(dispatchWhatsApp('opaque', { type: 'whatsapp', phoneNumberId: 'number' }, whatsapp, { type: 'pin', messageId: '1' })).rejects.toThrow('cannot pin')
    await expect(dispatchTelegram('opaque', { ...telegram, chatType: 'group' }, { type: 'keyboard', text: 'Open', rows: [[{ label: 'Open', webApp: 'https://example.org' }]] })).rejects.toThrow('private chat')
    expect(transport.telegram).not.toHaveBeenCalled(); expect(transport.whatsapp).not.toHaveBeenCalled(); expect(transport.upload).not.toHaveBeenCalled()
  })
  it('reuses verified original Telegram sticker IDs only for the matching connection and media kind', async () => {
    const attachment = { path: '/vault/fern', fileName: 'fern.tgs', mime: 'application/x-tgsticker', providerReference: { id: 'original', channelId: 'bot', media: 'sticker' as const, metadata: { media: 'sticker' as const } } }
    await dispatchTelegram('opaque', telegram, { type: 'attachment', media: 'sticker', attachmentId: 'fern' }, attachment)
    expect(JSON.parse(transport.telegram.mock.calls[0][1].body)).toMatchObject({ sticker: 'original' })
    expect(transport.upload).not.toHaveBeenCalled()
    transport.upload.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 4 } })))
    await dispatchTelegram('opaque', { ...telegram, channelId: 'different' }, { type: 'attachment', media: 'sticker', attachmentId: 'fern' }, attachment)
    expect(transport.upload).toHaveBeenCalledOnce()
  })
  it('checks WhatsApp media references and uploads the preserved original when they expired', async () => {
    const attachment = { path: '/vault/fern', fileName: 'fern.webp', mime: 'image/webp', providerReference: { id: 'original', channelId: 'bot', media: 'sticker' as const, metadata: { media: 'sticker' as const } } }
    transport.whatsapp.mockResolvedValueOnce(new Response('{}')).mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: 'sent' }] })))
    await dispatchWhatsApp('opaque', { type: 'whatsapp', phoneNumberId: 'number' }, whatsapp, { type: 'attachment', media: 'sticker', attachmentId: 'fern' }, attachment)
    expect(transport.upload).not.toHaveBeenCalled()
    expect(JSON.parse(transport.whatsapp.mock.calls[1][1].body)).toMatchObject({ sticker: { id: 'original' } })
    transport.whatsapp.mockResolvedValueOnce(new Response('{}', { status: 404 })).mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: 'sent-new' }] })))
    transport.upload.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'fresh' })))
    await dispatchWhatsApp('opaque', { type: 'whatsapp', phoneNumberId: 'number' }, whatsapp, { type: 'attachment', media: 'sticker', attachmentId: 'fern' }, attachment)
    expect(transport.upload).toHaveBeenCalledOnce()
    expect(JSON.parse(transport.whatsapp.mock.calls[3][1].body)).toMatchObject({ sticker: { id: 'fresh' } })
  })
})
