import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
type OwnerApi = PluginBackendOperationContext['api']
import type { ChannelMediaMetadata, MessageDestination, ChannelMediaKind } from '../../contracts/channel'
import { openOwnedAttachment } from '../attachments'
import { backendApi } from '../runtime'
import type { AssistantRepository } from '../persistence/repositories'
import type { InboundMediaJob } from './ingestionQueue'
import { DeliveryRejected } from './deliveryQueue'

export interface ChannelDispatchAttachment {
  path: string
  fileName: string
  mime: string
  providerReference?: { channelId: string; media: ChannelMediaKind; id: string; metadata: ChannelMediaMetadata }
}

export function probeWebP(bytes: Uint8Array, size: number): ChannelMediaMetadata {
  const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u24 = (offset: number) => bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16
  if (bytes.length < 20 || text(0) !== 'RIFF' || text(8) !== 'WEBP' || view.getUint32(4, true) + 8 !== size) throw new DeliveryRejected('Sticker is not a complete WebP file')
  for (let offset = 12, count = 0; offset + 8 <= bytes.length && count < 128; count++) {
    const type = text(offset), length = view.getUint32(offset + 4, true), data = offset + 8
    if (length > size - data) throw new DeliveryRejected('Sticker has an invalid WebP chunk')
    if (type === 'VP8X' && length >= 10 && data + 10 <= bytes.length) return { media: 'sticker', width: u24(data + 4) + 1, height: u24(data + 7) + 1, animated: Boolean(bytes[data] & 2) }
    if (type === 'VP8 ' && length >= 10 && data + 10 <= bytes.length && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) return { media: 'sticker', width: view.getUint16(data + 6, true) & 0x3fff, height: view.getUint16(data + 8, true) & 0x3fff, animated: false }
    if (type === 'VP8L' && length >= 5 && data + 5 <= bytes.length && bytes[data] === 0x2f) return { media: 'sticker', width: 1 + (bytes[data + 1] | (bytes[data + 2] & 0x3f) << 8), height: 1 + (bytes[data + 2] >> 6 | bytes[data + 3] << 2 | (bytes[data + 4] & 0x0f) << 10), animated: false }
    offset = data + length + length % 2
  }
  throw new DeliveryRejected('WebP dimensions could not be verified within the bounded header probe')
}

export async function probeLocalSticker(relativePath: string, mime: string, api: OwnerApi = backendApi()): Promise<ChannelMediaMetadata> {
  if (mime !== 'image/webp') throw new DeliveryRejected('A trusted local decoder is unavailable for this sticker format. Preserve the original or reuse its verified provider reference; no conversion was performed.')
  const file = await openOwnedAttachment(relativePath, api)
  if (!file) throw new DeliveryRejected('Import the sticker into this conversation before sending it')
  try {
    const part = await api.files.read(file.handle, { offset: 0, maxBytes: 65536 })
    return probeWebP(Uint8Array.from(atob(part.base64), character => character.charCodeAt(0)), file.size)
  } finally { await api.files.release([file.handle]) }
}

export async function trustedProviderReference(repository: AssistantRepository, destination: MessageDestination, attachmentId: string, media: ChannelMediaKind): Promise<ChannelDispatchAttachment['providerReference']> {
  if (!destination.channelId || !destination.chatRef) return undefined
  const jobs = await repository.rows<InboundMediaJob>('inbound_media_jobs', { conversationId: `channel:${destination.channelId}:${destination.chatRef}` })
  for (const job of jobs) {
    if (job.channelId !== destination.channelId || !['READY', 'DISPATCHING', 'COMPLETE'].includes(job.state)) continue
    const index = job.message.attachments?.findIndex(attachment => attachment.id === attachmentId) ?? -1
    const spec = index >= 0 ? job.message.media?.[index] : undefined
    if (spec?.provider === destination.kind && spec.metadata.media === media && spec.mediaId) return { channelId: job.channelId, media, id: spec.mediaId, metadata: spec.metadata }
  }
  return undefined
}
