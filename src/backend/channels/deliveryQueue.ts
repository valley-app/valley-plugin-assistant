import type { DeliveryReceipt, MessageContent, MessageDestination } from '../../contracts/channel'
import { AssistantRepository, record } from '../persistence/repositories'
import { runExclusive } from '../fileQueue'

export interface OutboundDelivery extends DeliveryReceipt {
  destination: MessageDestination
  content: MessageContent
  requestContent?: MessageContent
  triggeringCallId?: string
  parts?: Array<DeliveryReceipt & { content: MessageContent }>
}
export class DeliveryRejected extends Error {
  constructor(message: string, readonly retryAfterMs?: number) { super(message) }
}

export class DeliveryQueue {
  constructor(private repository: AssistantRepository) {}

  async recover(): Promise<void> {
    for (const delivery of await this.repository.rows<OutboundDelivery>('outbound_deliveries', { state: 'DISPATCHING' })) {
      delivery.state = 'UNKNOWN'; delivery.error = 'The app stopped before a provider receipt was saved. Do not retry automatically.'
      for (const part of delivery.parts ?? []) if (part.state === 'DISPATCHING') { part.state = 'UNKNOWN'; part.error = delivery.error }
      await this.persist(delivery)
    }
  }

  private persist(delivery: OutboundDelivery) {
    return this.repository.data.transaction([{ dataset: 'outbound_deliveries', operation: 'upsert', values: record(delivery.id, delivery.destination.conversationId, delivery.state, delivery) }])
  }

  async send(input: { id: string; destination: MessageDestination; content: MessageContent; triggeringCallId?: string }, dispatch: () => Promise<string[]>): Promise<OutboundDelivery> {
    return this.sendParts(input, [input.content], () => dispatch())
  }

  async sendParts(input: { id: string; destination: MessageDestination; content: MessageContent; requestContent?: MessageContent; triggeringCallId?: string }, contents: MessageContent[], dispatch: (content: MessageContent) => Promise<string[]>, retryFailed = false): Promise<OutboundDelivery> {
    return runExclusive(`delivery:${input.id}`, async () => {
      const existing = await this.repository.get<OutboundDelivery>('outbound_deliveries', input.id)
      if (existing) {
        if (JSON.stringify(existing.destination) !== JSON.stringify(input.destination) || JSON.stringify(existing.content) !== JSON.stringify(input.content)) throw new Error('Delivery identity conflicts with an existing message')
        const pending = existing.state !== 'FAILED' && existing.parts?.some(part => part.state === 'PENDING')
        if ((!retryFailed && !pending) || !existing.parts || existing.parts.some(part => part.state === 'UNKNOWN' || part.state === 'DISPATCHING')) return existing
      }
      const delivery: OutboundDelivery = existing ?? { ...input, state: 'PENDING', providerMessageIds: [], parts: contents.map((content, index) => ({ id: `${input.id}:${index}`, content, state: 'PENDING', providerMessageIds: [] })) }
      await this.persist(delivery)
      for (const part of delivery.parts ?? []) {
        if (['ACCEPTED', 'DELIVERED', 'READ'].includes(part.state)) continue
        if (!['PENDING', 'FAILED'].includes(part.state)) break
        part.state = 'DISPATCHING'; part.error = undefined; delivery.state = 'DISPATCHING'; delivery.error = undefined
        await this.persist(delivery)
        try { part.providerMessageIds = await dispatch(part.content); part.state = 'ACCEPTED' }
        catch (error) { part.state = error instanceof DeliveryRejected ? 'FAILED' : 'UNKNOWN'; part.error = String(error) }
        delivery.providerMessageIds = (delivery.parts ?? []).flatMap(part => part.providerMessageIds)
        delivery.state = part.state; delivery.error = part.error
        await this.persist(delivery)
        if (part.state === 'FAILED' || part.state === 'UNKNOWN') break
      }
      if (delivery.parts?.every(part => ['ACCEPTED', 'DELIVERED', 'READ'].includes(part.state))) delivery.state = 'ACCEPTED'
      await this.persist(delivery)
      return delivery
    })
  }

  async providerReceipt(channelId: string, providerMessageId: string, state: 'DELIVERED' | 'READ' | 'FAILED', error?: string): Promise<void> {
    for (const delivery of await this.repository.rows<OutboundDelivery>('outbound_deliveries')) {
      if (delivery.destination.channelId !== channelId || !delivery.providerMessageIds.includes(providerMessageId)) continue
      await runExclusive(`delivery:${delivery.id}`, async () => {
        const current = await this.repository.get<OutboundDelivery>('outbound_deliveries', delivery.id)
        if (!current) return
        const part = current.parts?.find(value => value.providerMessageIds.includes(providerMessageId))
        if (part && part.state !== 'READ' && !(part.state === 'DELIVERED' && state === 'FAILED')) { part.state = state; part.error = error }
        if (current.parts?.every(value => value.state === 'READ')) { current.state = 'READ'; current.error = undefined }
        else if (current.parts?.every(value => ['DELIVERED', 'READ'].includes(value.state))) { current.state = 'DELIVERED'; current.error = undefined }
        else if (current.parts?.some(value => value.state === 'FAILED')) { current.state = 'FAILED'; current.error = current.parts.find(value => value.state === 'FAILED')?.error }
        await this.persist(current)
      })
    }
  }

  async receipt(id: string, status: 'DELIVERED' | 'READ'): Promise<void> {
    await runExclusive(`delivery:${id}`, async () => {
      const delivery = await this.repository.get<OutboundDelivery>('outbound_deliveries', id)
      if (!delivery || !['ACCEPTED', 'DELIVERED', 'READ'].includes(delivery.state)) return
      if (delivery.state === 'READ') return
      delivery.state = status
      await this.persist(delivery)
    })
  }
}
