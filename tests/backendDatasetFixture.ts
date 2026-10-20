import type { PluginBackendApi } from '@valley/plugin-sdk'
export function datasetFixture(): PluginBackendApi['data'] {
  const tables = new Map<string, Array<Record<string, unknown>>>()
  const revisions = new Map<string, number>()
  const fixture = { dataset(name: string) {
    const rows = tables.get(name) ?? []
    tables.set(name, rows)
    const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}) => Object.entries(where).every(([key, value]) => row[key] === value)
    const key = (row: Record<string, unknown>) => name === 'attachment_refs' ? { attachmentId: row.attachmentId, chatId: row.chatId } : { id: row.id }
    return {
      read: async (where: Record<string, unknown>) => ({ value: structuredClone(rows.find(row => matches(row, where)) ?? null), revision: revisions.get(name) ?? 0 }),
      get: async (where: Record<string, unknown>) => structuredClone(rows.find(row => matches(row, where)) ?? null),
      query: async ({ where = {}, cursor = '0', limit = 500 } = {}) => {
        const filtered = rows.filter(row => matches(row, where)), offset = Number(cursor)
        return { rows: structuredClone(filtered.slice(offset, offset + limit)), ...(offset + limit < filtered.length ? { cursor: String(offset + limit) } : {}) }
      },
      count: async (where = {}) => rows.filter(row => matches(row, where)).length,
      insert: async (record: Record<string, unknown> | Array<Record<string, unknown>>) => { for (const row of Array.isArray(record) ? record : [record]) { if (rows.some(existing => matches(existing, key(row)))) throw new Error('Duplicate record'); rows.push(structuredClone(row)) } },
      upsert: async (record: Record<string, unknown> | Array<Record<string, unknown>>) => { for (const row of Array.isArray(record) ? record : [record]) { const index = rows.findIndex(existing => matches(existing, key(row))); if (index < 0) rows.push(structuredClone(row)); else rows[index] = { ...rows[index], ...structuredClone(row) } } },
      update: async (where: Record<string, unknown>, patch: Record<string, unknown>) => { if (Object.keys(key({})).some(column => column in patch)) throw new Error('Primary-key updates are not supported'); for (const row of rows) if (matches(row, where)) Object.assign(row, structuredClone(patch)) },
      delete: async (where: Record<string, unknown>) => { for (let index = rows.length - 1; index >= 0; index--) if (matches(rows[index], where)) rows.splice(index, 1) }
    }
  }, async transaction(operations: Array<{ dataset: string; operation: string; key?: Record<string, unknown>; values?: Record<string, unknown> }>) {
    const before = structuredClone(tables)
    try {
      for (const operation of operations) {
        const table = fixture.dataset(operation.dataset)
        if (operation.operation === 'insert') await table.insert(operation.values!)
        else if (operation.operation === 'upsert') await table.upsert(operation.values!)
        else if (operation.operation === 'update') await table.update(operation.key!, operation.values!)
        else if (operation.operation === 'delete') await table.delete(operation.key!)
        else throw new Error(`Fixture transaction operation unsupported: ${operation.operation}`)
      }
      for (const name of new Set(operations.map(operation => operation.dataset))) revisions.set(name, (revisions.get(name) ?? 0) + 1)
    } catch (error) {
      tables.clear()
      for (const [name, rows] of before) tables.set(name, rows)
      throw error
    }
  } }
  return fixture as unknown as PluginBackendApi['data']
}
