import '../backendFileFixture'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentExtractions } from '../../src/backend/attachments/extractions'
import { AssistantRepository, record } from '../../src/backend/persistence/repositories'
import { datasetFixture } from '../backendDatasetFixture'
import { detectType } from '../../src/backend/attachments/detectType'
describe('durable attachment extraction', () => {
  it('reuses a committed transcription on retry without calling its provider again', async () => {
    const repository = new AssistantRepository(datasetFixture()), extract = vi.fn(async () => ({ text: 'Describe fern spores' }))
    await new AttachmentExtractions(repository).read('turn:audio', 'fern', extract)
    expect(await new AttachmentExtractions(repository).read('turn:audio', 'fern', extract)).toEqual({ text: 'Describe fern spores' })
    expect(extract).toHaveBeenCalledOnce()
  })
  it('refuses a blind repeat when shutdown or a persistence failure leaves the provider outcome unknown', async () => {
    const repository = new AssistantRepository(datasetFixture()), extract = vi.fn(async () => ({ text: 'Already billed' }))
    await repository.data.transaction([{ dataset: 'attachment_extractions', operation: 'insert', values: record('turn:audio', 'fern', 'RUNNING', { id: 'turn:audio', state: 'RUNNING' }) }])
    await expect(new AttachmentExtractions(repository).read('turn:audio', 'fern', extract)).rejects.toThrow('unknown')
    expect(extract).not.toHaveBeenCalled()
  })
  it('retains animated sticker containers without attempting unsafe decompression', () => {
    expect(detectType(new Uint8Array([0x1f, 0x8b, 8, 0]), 'application/x-tgsticker')).toEqual({ mime: 'application/x-tgsticker', kind: 'file' })
    const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new TextEncoder().encode('webm')])
    expect(detectType(bytes, 'video/webm')).toEqual({ mime: 'video/webm', kind: 'file' })
    expect(detectType(bytes, 'audio/webm')).toEqual({ mime: 'audio/webm', kind: 'audio' })
  })
})
