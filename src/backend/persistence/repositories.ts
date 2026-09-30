import type { PluginBackendApi } from '@valley/plugin-sdk'
import type { DatasetRecord, DatasetTransactionOperation, DatasetValue } from '@valley/plugin-sdk/datasets'
import type { SessionEvent, SessionSnapshot } from '../../contracts/execution'

export type DurableRecord = DatasetRecord & { id: string; conversationId: string; state: string; revision: number; payload: DatasetValue; updatedAt: number }
export function record(id: string, conversationId: string, state: string, payload: unknown, revision = 0): DurableRecord {
  return { id, conversationId, state, revision, payload: JSON.parse(JSON.stringify(payload)), updatedAt: Date.now() }
}

export class AssistantRepository {
  constructor(readonly data: PluginBackendApi['data']) {}

  async get<T>(dataset: string, id: string): Promise<T | null> {
    const row = await this.data.dataset<DurableRecord>(dataset).get({ id })
    return row ? row.payload as T : null
  }

  async rows<T>(dataset: string, where: Record<string, string> = {}): Promise<T[]> {
    const result: T[] = []
    let cursor: string | undefined
    do {
      const page = await this.data.dataset<DurableRecord>(dataset).query({ where, cursor, limit: 500 })
      result.push(...page.rows.map(row => row.payload as T))
      cursor = page.cursor
    } while (cursor)
    return result
  }

  async commit(snapshot: SessionSnapshot, type: string, payload: unknown, effects: DatasetTransactionOperation[] = []): Promise<SessionEvent> {
    const event: SessionEvent = { id: crypto.randomUUID(), conversationId: snapshot.conversationId, revision: snapshot.revision + 1, type, payload, createdAt: Date.now() }
    const next = { ...snapshot, revision: event.revision }
    await this.data.transaction([
      { dataset: 'sessions', operation: 'upsert', values: record(next.conversationId, next.conversationId, next.state, next, next.revision) },
      { dataset: 'session_events', operation: 'insert', values: record(event.id, next.conversationId, type, event, next.revision) },
      ...effects
    ])
    snapshot.revision = next.revision
    return event
  }
}
