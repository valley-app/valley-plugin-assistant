const statuses = new Set(['accepted', 'awaiting-approval', 'running', 'cancel-requested', 'completed', 'failed', 'cancelled', 'uncertain'])

export function commandResult(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.command !== 'string' || typeof record.revision !== 'number' || typeof record.status !== 'string' || !statuses.has(record.status)) return value
  if (record.status === 'completed') return value
  const detail = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : {}
  const unknown = !['failed', 'cancelled'].includes(record.status) || detail.outcome === 'unknown'
  throw Object.assign(new Error(typeof detail.message === 'string' ? detail.message : `Command ${record.command} is ${record.status}. Inspect execution ${record.id} before retrying.`), { code: typeof detail.code === 'string' ? detail.code : 'COMMAND_NOT_COMPLETED', outcome: unknown ? 'unknown' : 'not-applied', ...(detail.recoverable === false ? { recoverable: false } : {}), execution: record })
}
