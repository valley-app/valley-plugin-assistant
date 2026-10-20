import type { PluginBackendApi } from '@valley/plugin-sdk'
import type { DatasetRecord, DatasetTransactionOperation, DatasetValue } from '@valley/plugin-sdk/datasets'
import type { PluginDatasetApi } from '@valley/plugin-sdk'
import type { SessionEvent, SessionSnapshot } from '../../contracts/execution'

export type DurableRecord = DatasetRecord & { id: string; conversationId: string; state: string; revision: number; payload: DatasetValue; updatedAt: number }
export function record(id: string, conversationId: string, state: string, payload: unknown, revision = 0): DurableRecord {
  return { id, conversationId, state, revision, payload: JSON.parse(JSON.stringify(payload)), updatedAt: Date.now() }
}
/** The columns a dataset update may change: the host refuses primary-key columns in update values. */
export function changes(conversationId: string, state: string, payload: unknown, revision = 0): Omit<DurableRecord, 'id'> {
  return { conversationId, state, revision, payload: JSON.parse(JSON.stringify(payload)), updatedAt: Date.now() }
}

/** One query page. The host refuses a response over 8 MiB, so the same cursor is asked again for half as many rows. */
export async function boundedQuery<T extends DatasetRecord>(dataset: Pick<PluginDatasetApi<T>, 'query'>, query: NonNullable<Parameters<PluginDatasetApi<T>['query']>[0]> & { limit: number }): ReturnType<PluginDatasetApi<T>['query']> {
  for (let limit = query.limit; ; limit = Math.ceil(limit / 2)) {
    try { return await dataset.query({ ...query, limit }) } catch (error) { if (limit <= 1 || (error as { code?: unknown } | null)?.code !== 'limit-exceeded') throw error }
  }
}

export class AssistantRepository {
  constructor(readonly data: PluginBackendApi['data']) {}

  async get<T>(dataset: string, id: string): Promise<T | null> {
    const row = await this.data.dataset<DurableRecord>(dataset).get({ id })
    return row ? row.payload as T : null
  }

  async rows<T>(dataset: string, where: Record<string, string> = {}, limit = 500): Promise<T[]> {
    const result: T[] = []
    let cursor: string | undefined
    do {
      const page = await boundedQuery(this.data.dataset<DurableRecord>(dataset), { where, cursor, limit })
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
