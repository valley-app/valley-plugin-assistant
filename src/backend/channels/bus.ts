import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
type OwnerApi = PluginBackendOperationContext['api']
import path from 'path-browserify'
import type { MessageContent, MessageDestination } from '../../contracts/channel'
import { conversationAttachmentMetadata } from '../attachments'
import { AssistantRepository } from '../persistence/repositories'
import { DeliveryQueue, DeliveryRejected, type OutboundDelivery } from './deliveryQueue'
import { validateContent, resolveMedia } from './capabilities'
import { formatChannelParts } from './formatting'
import { channelManager } from './manager'
import { VAULT_ROOT, backendApi } from '../runtime'
import { effectiveSettings } from '../configuration/settings'
import { probeLocalSticker, trustedProviderReference, type ChannelDispatchAttachment } from './mediaProbe'

export class ChannelBus {
  readonly deliveries: DeliveryQueue
  constructor(private repository: AssistantRepository, private local: (destination: MessageDestination, content: MessageContent) => Promise<string[]>, private api: OwnerApi = backendApi()) {
    this.deliveries = new DeliveryQueue(repository)
  }
  async send(input: { id: string; conversationId: string; destination: MessageDestination; content: MessageContent; triggeringCallId?: string }, retryFailed = false) {
    const { destination } = input
    if (destination.conversationId !== input.conversationId) throw new DeliveryRejected('Messaging is limited to the current conversation')
    const previous = await this.repository.get<OutboundDelivery>('outbound_deliveries', input.id)
    if (previous) {
      if (JSON.stringify(previous.destination) !== JSON.stringify(destination) || JSON.stringify(previous.requestContent ?? previous.content) !== JSON.stringify(input.content)) throw new DeliveryRejected('Delivery identity conflicts with an existing message')
      const resumable = previous.state !== 'FAILED' && previous.parts?.some(part => part.state === 'PENDING') && !previous.parts.some(part => ['UNKNOWN', 'DISPATCHING'].includes(part.state))
      if (!resumable && !(retryFailed && previous.state === 'FAILED')) return previous
    }
    let content = input.content
    if (destination.kind === 'whatsapp' && !['template', 'read'].includes(content.type)) {
      const receipts = await this.repository.rows<{ receivedAt: number }>('inbound_receipts', { conversationId: destination.conversationId })
      if (!receipts.some(receipt => receipt.receivedAt > Date.now() - 24 * 60 * 60 * 1000)) throw new DeliveryRejected('The WhatsApp reply window is closed. Use an approved template.')
    }
    let attachment: ChannelDispatchAttachment | undefined
    if (content.type === 'attachment') {
      if (!content.attachmentId) throw new DeliveryRejected('Import the file and provide its attachment reference before sending')
      const found = await conversationAttachmentMetadata(content.attachmentId, input.conversationId, this.api)
      const media = resolveMedia(content, found.attachment.mime)
      const providerReference = await trustedProviderReference(this.repository, destination, content.attachmentId, media)
      attachment = { path: path.join(VAULT_ROOT, found.attachment.path), fileName: found.attachment.fileName, mime: found.attachment.mime, ...(providerReference ? { providerReference } : {}) }
      if (media === 'sticker') {
        const metadata = providerReference?.metadata ?? await probeLocalSticker(found.attachment.path, found.attachment.mime, this.api)
        if (destination.kind === 'telegram' && found.attachment.mime === 'image/webp' && metadata.animated) throw new DeliveryRejected('Telegram does not accept animated WebP as a sticker. Preserve the original; no conversion was performed.')
        content = { ...content, metadata }
      }
      const limit = (await effectiveSettings(VAULT_ROOT, this.api)).importMaxBytes
      for (const part of formatChannelParts(content, destination.kind)) validateContent(destination, part, part.type === 'attachment' ? { mime: found.attachment.mime, bytes: found.bytes } : undefined, limit)
    }
    const parts = formatChannelParts(content, destination.kind)
    if (!parts.length) throw new DeliveryRejected('Message is empty after channel formatting')
    for (const part of parts) validateContent(destination, part)
    return this.deliveries.sendParts({ ...input, content, requestContent: input.content }, parts, part => destination.kind === 'chat' ? this.local(destination, part) : channelManager.dispatch(destination, part, attachment, this.api), retryFailed)
  }
  async retry(id: string, conversationId: string) {
    const delivery = await this.repository.get<OutboundDelivery & { conversationId?: string }>('outbound_deliveries', id)
    if (!delivery || (delivery.conversationId ?? delivery.destination.conversationId) !== conversationId) throw new DeliveryRejected('Delivery is unavailable to this conversation')
    if (delivery.state !== 'FAILED') throw new DeliveryRejected('Only a confirmed failed delivery may be retried; unknown outcomes require reconciliation')
    return this.send({ id, conversationId, destination: delivery.destination, content: delivery.requestContent ?? delivery.content, triggeringCallId: delivery.triggeringCallId }, true)
  }
}
