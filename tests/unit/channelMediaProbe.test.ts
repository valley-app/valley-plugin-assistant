import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { probeWebP, trustedProviderReference } from '../../src/backend/channels/mediaProbe'
import { ChannelBus } from '../../src/backend/channels/bus'
import { AssistantRepository, record } from '../../src/backend/persistence/repositories'
import { initBackend } from '../../src/backend/runtime'
import { datasetFixture } from '../backendDatasetFixture'

const hooks = vi.hoisted(() => ({ metadata: vi.fn(), open: vi.fn(), dispatch: vi.fn() }))
vi.mock('../../src/backend/attachments', () => ({ conversationAttachmentMetadata: hooks.metadata, openOwnedAttachment: hooks.open }))
vi.mock('../../src/backend/channels/manager', () => ({ channelManager: { dispatch: hooks.dispatch } }))
vi.mock('../../src/backend/configuration/settings', () => ({ effectiveSettings: async () => ({ importMaxBytes: 32 * 1024 * 1024 }) }))
function webp(width: number, height: number, animated = false) {
  const bytes = new Uint8Array(30), view = new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode('RIFF'), 0); view.setUint32(4, 22, true); bytes.set(new TextEncoder().encode('WEBPVP8X'), 8); view.setUint32(16, 10, true)
  bytes[20] = animated ? 2 : 0
  for (let i = 0; i < 3; i++) { bytes[24 + i] = (width - 1) >> (8 * i) & 255; bytes[27 + i] = (height - 1) >> (8 * i) & 255 }
  return bytes
}
beforeEach(() => { hooks.metadata.mockReset(); hooks.open.mockReset(); hooks.dispatch.mockReset().mockResolvedValue(['sent']) })

describe('bounded sticker probes and provider provenance', () => {
  it('reads dimensions and animation from WebP bytes and rejects malformed container lengths', () => {
    expect(probeWebP(webp(512, 256), 30)).toEqual({ media: 'sticker', width: 512, height: 256, animated: false })
    expect(probeWebP(webp(512, 512, true), 30)).toMatchObject({ animated: true })
    expect(() => probeWebP(webp(512, 512), 300)).toThrow('complete WebP')
    expect(() => probeWebP(new Uint8Array(16), 16)).toThrow('WebP')
  })
  it('rejects invalid actual sticker dimensions even when caller metadata claims valid dimensions', async () => {
    const data = datasetFixture(), bytes = webp(123, 456)
    const read = vi.fn(async () => ({ base64: btoa(String.fromCharCode(...bytes)), done: true })), release = vi.fn(async () => {})
    initBackend({ data, files: { read, release } } as unknown as PluginBackendApi)
    hooks.metadata.mockResolvedValue({ attachment: { path: 'blob', fileName: 'sticker.webp', mime: 'image/webp' }, bytes: bytes.length })
    hooks.open.mockResolvedValue({ handle: 'file', size: bytes.length })
    const bus = new ChannelBus(new AssistantRepository(data), vi.fn())
    await expect(bus.send({ id: 'send', conversationId: 'chat', destination: { kind: 'telegram', conversationId: 'chat', channelId: 'bot', chatRef: '123' }, content: { type: 'attachment', attachmentId: 'attachment', media: 'sticker', metadata: { media: 'sticker', width: 512, height: 512 } } })).rejects.toThrow('dimensions')
    expect(read).toHaveBeenCalledWith('file', { offset: 0, maxBytes: 65536 })
    expect(release).toHaveBeenCalledWith(['file'])
    expect(hooks.dispatch).not.toHaveBeenCalled()
  })
  it('derives reuse authority only from a persisted attachment on the same connection and media kind', async () => {
    const data = datasetFixture(), repository = new AssistantRepository(data)
    initBackend({ data } as unknown as PluginBackendApi)
    await data.transaction([{ dataset: 'inbound_media_jobs', operation: 'insert', values: record('job', 'channel:bot:123', 'COMPLETE', { id: 'job', channelId: 'bot', state: 'COMPLETE', message: { attachments: [{ id: 'attachment' }], media: [{ provider: 'telegram', mediaId: 'trusted-file', metadata: { media: 'sticker', animated: true } }] } }) }])
    const destination = { kind: 'telegram' as const, conversationId: 'chat', channelId: 'bot', chatRef: '123' }
    expect(await trustedProviderReference(repository, destination, 'attachment', 'sticker')).toMatchObject({ id: 'trusted-file', channelId: 'bot' })
    expect(await trustedProviderReference(repository, { ...destination, channelId: 'other' }, 'attachment', 'sticker')).toBeUndefined()
    expect(await trustedProviderReference(repository, destination, 'forged-id', 'sticker')).toBeUndefined()
    expect(await trustedProviderReference(repository, destination, 'attachment', 'image')).toBeUndefined()
  })
  it('returns accepted receipts after a WhatsApp window closes without reopening files or sending again', async () => {
    const data = datasetFixture(), repository = new AssistantRepository(data), bus = new ChannelBus(repository, vi.fn())
    const destination = { kind: 'whatsapp' as const, conversationId: 'chat', channelId: 'wa', chatRef: '123' }
    const content = { type: 'attachment' as const, attachmentId: 'file', media: 'file' as const }
    await data.transaction([{ dataset: 'outbound_deliveries', operation: 'insert', values: record('known', 'chat', 'ACCEPTED', { id: 'known', destination, content, state: 'ACCEPTED', providerMessageIds: ['remote'], parts: [{ id: 'known:0', content, state: 'ACCEPTED', providerMessageIds: ['remote'] }] }) }])
    expect(await bus.send({ id: 'known', conversationId: 'chat', destination, content })).toMatchObject({ state: 'ACCEPTED', providerMessageIds: ['remote'] })
    expect(hooks.metadata).not.toHaveBeenCalled(); expect(hooks.dispatch).not.toHaveBeenCalled()
    await expect(bus.send({ id: 'known', conversationId: 'chat', destination, content: { ...content, attachmentId: 'different' } })).rejects.toThrow('conflicts')
  })
})
