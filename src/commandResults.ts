import type { PluginCommand, ValleyPluginApi } from '@valley/plugin-sdk'
import type { CommandSideEffect } from '@valley/plugin-sdk/commands'
import config from '../config.json'

const text = { type: 'string', maxLength: 1048576 }
const number = { type: 'number' }
const boolean = { type: 'boolean' }
const object = (properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false })
const list = (items: Record<string, unknown>) => ({ type: 'array', items, maxItems: 10000 })
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] })
const bound = (raw: unknown): Record<string, unknown> => {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit)
    if (!value || typeof value !== 'object') return value
    const schema = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]))
    if (schema.type === 'string' && schema.maxLength === undefined) schema.maxLength = 1048576
    if (schema.type === 'array' && schema.maxItems === undefined) schema.maxItems = 10000
    return schema
  }
  return visit(raw) as Record<string, unknown>
}
const contracts = config.runtime.services.flatMap(service => {
  const metadata = service.metadata as { command?: { id: string; outputSchema: Record<string, unknown> } } | undefined
  return metadata?.command ? [metadata.command] : []
})
const result = (id: string) => {
  const schema = contracts.find(command => command.id === id)?.outputSchema
  if (!schema) throw new Error(`Missing Assistant result declaration: ${id}`)
  return schema
}
const thread = bound(((result('readChat').properties as Record<string, unknown>).thread as { anyOf: Record<string, unknown>[] }).anyOf.find(schema => schema.type === 'object'))
const summary = bound((result('listChats').properties as Record<string, unknown>).chats)
const settingValue = { anyOf: [text, number, boolean, list(text)] }
const settings = { type: 'object', maxProperties: 10000, additionalProperties: settingValue }
const setting = object({ key: text, label: text, description: text, type: { enum: ['text', 'number', 'boolean', 'select', 'textarea', 'range'] }, default: settingValue, required: boolean, min: number, max: number, step: number, options: list(object({ value: text, label: text })) }, ['key', 'label', 'type'])
const execution = object({ timeoutMs: number, memoryMb: number, maxResponseBytes: number, maxTurns: number, maxConcurrency: number })
const target = object({ provider: text, connectionId: text, model: text }, ['provider', 'model'])
const run = object({ id: text, harnessId: text, harnessVersion: text, sourceDigest: text, startedAt: number, completedAt: number, status: { enum: ['running', 'completed', 'cancelled', 'error'] }, options: object({ useCache: boolean, concurrency: number }), targets: list(object({ target, score: number, cases: list(object({ id: text, name: text, weight: number, status: { enum: ['pass', 'fail', 'skip', 'error'] }, score: number, assertions: list(object({ name: text, passed: boolean, message: text }, ['name', 'passed'])), metrics: { type: 'object', maxProperties: 10000, additionalProperties: number }, error: object({ kind: text, message: text, attempts: number }, ['kind', 'message']), hostMetrics: object({ latencyMs: number, inputTokens: number, outputTokens: number, costUsd: number, retries: number, cacheHits: number, turnCount: number }) }, ['id', 'name', 'weight', 'status', 'score', 'assertions', 'metrics', 'hostMetrics'])) })), error: text }, ['id', 'harnessId', 'harnessVersion', 'sourceDigest', 'startedAt', 'status', 'options', 'targets'])
const manifest = object({ apiVersion: { const: 1 }, id: text, name: text, version: text, description: text, author: text, enabled: boolean }, ['apiVersion', 'id', 'name', 'version', 'description', 'enabled'])
const packageConfig = object({ packageKind: { const: 'ai-harness' }, main: text, icon: text, settingsSchema: list(setting), execution, retry: object({ maxAttempts: number, baseDelayMs: number, maxDelayMs: number }), cache: object({ maxAgeDays: number, maxSizeMb: number }) })
const packageStatus = object({ id: text, name: text, version: text, description: text, author: text, enabled: boolean, icon: text, ready: boolean, error: text, updateAvailable: boolean, sourceDigest: text, caseCount: number, settingsSchema: list(setting), settings, execution }, ['id', 'name', 'version', 'description', 'enabled', 'icon', 'ready', 'settingsSchema', 'settings', 'execution'])
const harnesses = object({ harnesses: list(packageStatus) })
const model = object({ provider: text, id: text, label: text, tools: boolean, web: boolean, contextWindow: number, reasoningEfforts: list(text) }, ['provider', 'id'])
export const assistantResults: Record<string, Record<string, unknown>> = {
  open: { type: 'null' }, 'new-chat': { type: 'null' }, ask: text,
  'providers-reload': object({ providers: list(object({ provider: text, name: text, description: text, icon: text, capabilities: list(text), configured: boolean, authMode: { enum: ['env', 'key', 'none'] }, authSources: object({ envKey: boolean, savedKey: boolean, savedKeyUnreadable: boolean, savedKeyUnchecked: boolean }, []), baseUrl: text, models: list(model) }, ['provider', 'configured', 'models'])) }),
  'list-chats': summary, 'read-chat': thread, 'create-chat': thread, 'update-chat': thread, 'update-properties': thread, 'send-message': thread,
  'open-chat': object({ id: text }), 'clear-chat': object({ id: text, operation: { const: 'clear-chat' } }), 'delete-chat': object({ id: text, operation: { const: 'delete-chat' } }), 'stop-chat': object({ id: text, stopped: boolean }), 'read-memory': bound(result('readMemory')),
  'harness-list': harnesses, 'harness-reload': harnesses, 'harness-inspect': object({ package: nullable(object({ manifest, config: packageConfig, readOnly: boolean, files: list(object({ path: text, content: text, baseline: nullable(object({ mtimeMs: number, size: number, hash: text })) })) }, ['manifest', 'config', 'files'])), runs: list(run) }), 'harness-run': object({ run }), 'harness-cancel': object({ cancelled: boolean }), 'harness-history': object({ runs: list(run) }), 'harness-clear-cache': object({ ok: { const: true } })
}

export const commandRegistrar = (api: Pick<ValleyPluginApi, 'commands'>) => <I = void, O = void, E extends CommandSideEffect = 'read'>(command: PluginCommand<I, O, E> & { outputSchema: Record<string, unknown> }): (() => void) => api.commands.register(command)
