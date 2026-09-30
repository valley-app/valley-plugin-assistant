import { AssistantRepository, record } from '../persistence/repositories'
import { runExclusive } from '../fileQueue'
import type { DatasetTransactionOperation } from '@valley/plugin-sdk/datasets'

export class InboundDeduplicator {
  private recent = new Map<string, number>()
  constructor(private repository: AssistantRepository) {}
  async accept(connectionId: string, providerEventId: string, conversationId: string, effects: DatasetTransactionOperation[]): Promise<boolean> {
    if (!providerEventId) throw new Error('A stable provider event ID is required')
    const id = JSON.stringify([connectionId, providerEventId])
    return runExclusive(`inbound:${id}`, async () => {
      const now = Date.now()
      for (const [key, expiry] of this.recent) if (expiry <= now) this.recent.delete(key)
      if (this.recent.has(id) || await this.repository.get('inbound_receipts', id)) return false
      await this.repository.data.transaction([
        { dataset: 'inbound_receipts', operation: 'insert', values: record(id, conversationId, 'ACCEPTED', { connectionId, providerEventId, receivedAt: now }) },
        ...effects
      ])
      if (this.recent.size >= 4096) this.recent.delete(this.recent.keys().next().value!)
      this.recent.set(id, now + 300000)
      return true
    })
  }
}
