import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { initBackend } from '../../src/backend/runtime'
import { InboundMediaQueue, type InboundMediaJob } from '../../src/backend/channels/ingestionQueue'
import { AssistantRepository, record } from '../../src/backend/persistence/repositories'
import { datasetFixture } from '../backendDatasetFixture'
import type { ChannelInboundMessage } from '../../src/backend/channels/types'

const imported = vi.hoisted(() => vi.fn(async (input: { fileName: string; fileHandle: string }) => ({ id: crypto.randomUUID(), path: `attachment/${input.fileHandle}`, fileName: input.fileName, kind: 'image' as const, mime: 'image/webp' })))
vi.mock('../../src/backend/attachments', () => ({ importAttachmentFile: imported }))
let files: Map<string, Uint8Array>, writes: number[]
beforeEach(() => {
  files = new Map(); writes = []; imported.mockClear()
  initBackend({ storage: {
    open: async () => ({ handle: 'fixture' }), mkdir: async () => {},
    stat: async (location: { path: string }) => files.has(location.path) ? { size: files.get(location.path)!.length, kind: 'file' } : null,
    writeBytes: async (location: { path: string }, base64: string, append: boolean) => {
      const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0)); writes.push(bytes.length)
      const before = append ? files.get(location.path) ?? new Uint8Array() : new Uint8Array()
      const next = new Uint8Array(before.length + bytes.length); next.set(before); next.set(bytes, before.length); files.set(location.path, next)
    },
    move: async (from: { path: string }, to: { path: string }) => { files.set(to.path, files.get(from.path)!); files.delete(from.path) },
    remove: async (location: { path: string }) => { files.delete(location.path) },
    exportFile: async (location: { path: string }) => ({ handle: location.path })
  }, files: { release: async () => {} } } as unknown as PluginBackendApi)
})
const message = (id: string): ChannelInboundMessage => ({ providerEventId: id, providerMessageId: id, chatRef: 'fern', senderId: 'fern', text: '', media: [{ provider: 'telegram', mediaId: 'sticker', kind: 'image', fileName: 'fern.webp', mime: 'image/webp', metadata: { media: 'sticker' } }] })
const downloaded = () => ({ response: new Response(new Uint8Array(200000).fill(1)), fileName: 'fern.webp', mime: 'image/webp', maxBytes: 500000 })

describe('durable eager channel ingestion', () => {
  it('commits before slow download and deduplicates the event, with bounded spool writes', async () => {
    const repository = new AssistantRepository(datasetFixture())
    let release!: (value: ReturnType<typeof downloaded>) => void
    const download = vi.fn(() => new Promise<ReturnType<typeof downloaded>>(resolve => { release = resolve }))
    const receive = vi.fn(async (_channelId: string, _message: ChannelInboundMessage) => {}), error = vi.fn()
    const queue = new InboundMediaQueue(repository, { download, receive, error })
    await queue.accept('bot', message('1')); await queue.accept('bot', message('1'))
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce())
    expect(await repository.rows('inbound_media_jobs')).toHaveLength(1)
    expect(receive).not.toHaveBeenCalled()
    release(downloaded())
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce())
    await vi.waitFor(async () => expect((await repository.rows<InboundMediaJob>('inbound_media_jobs'))[0].state).toBe('COMPLETE'))
    expect(Math.max(...writes)).toBeLessThanOrEqual(65536)
    expect(receive.mock.calls[0][1]).toMatchObject({ attachments: [{ fileName: 'fern.webp', metadata: { media: 'sticker' } }] })
    expect(files.size).toBe(0)
    await queue.stop()
  })
  it('records download failure without an empty turn and retries the original event', async () => {
    const repository = new AssistantRepository(datasetFixture())
    const download = vi.fn().mockRejectedValueOnce(new Error('expired media')).mockImplementationOnce(async () => downloaded())
    const receive = vi.fn(async () => {}), error = vi.fn()
    const queue = new InboundMediaQueue(repository, { download, receive, error })
    await queue.accept('bot', message('1'))
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce())
    expect(receive).not.toHaveBeenCalled()
    await queue.retry(JSON.stringify(['bot', '1']))
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce())
    expect(download).toHaveBeenCalledTimes(2)
    await queue.stop()
  })
  it('recovers a promoted attachment without re-downloading after dispatch interruption', async () => {
    const repository = new AssistantRepository(datasetFixture()), id = JSON.stringify(['bot', '1'])
    const job: InboundMediaJob = { id, channelId: 'bot', message: { ...message('1'), attachments: [{ id: 'attachment', path: 'attachment/fern', fileName: 'fern.webp', kind: 'image', metadata: { media: 'sticker' } }] }, state: 'DISPATCHING', attempts: 1, spool: {} }
    await repository.data.transaction([{ dataset: 'inbound_media_jobs', operation: 'insert', values: record(id, 'fern', job.state, job) }])
    const download = vi.fn(async () => downloaded()), receive = vi.fn(async () => {})
    const queue = new InboundMediaQueue(repository, { download, receive, error: vi.fn() })
    await queue.recover(); await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce())
    expect(download).not.toHaveBeenCalled(); expect(imported).not.toHaveBeenCalled()
    await queue.stop()
  })
  it('rejects oversized streams before attachment promotion', async () => {
    const repository = new AssistantRepository(datasetFixture()), receive = vi.fn(async () => {}), error = vi.fn()
    const queue = new InboundMediaQueue(repository, { download: async () => ({ ...downloaded(), maxBytes: 10 }), receive, error })
    await queue.accept('bot', message('large'))
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce())
    expect(receive).not.toHaveBeenCalled(); expect(imported).not.toHaveBeenCalled(); expect(files.size).toBe(0)
    await queue.stop()
  })
})
