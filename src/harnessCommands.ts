import type { ValleyPluginApi } from './api'
import type { HarnessPackageSnapshot, HarnessPackageStatus, HarnessRun, HarnessTarget } from './harnessTypes'

const asStr = (value: unknown): string => typeof value === 'string' ? value : ''
const clampLimit = (value: unknown, fallback: number): number => Number.isFinite(Number(value)) ? Math.max(1, Math.min(500, Math.floor(Number(value)))) : fallback

export function registerHarnessCommands(api: ValleyPluginApi): () => void {
  const offs: (() => void)[] = []
  const t = api.ui.t
  const string = { type: 'string', minLength: 1 }
  const inputSchema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false })
  const invokeAiData = <T>(method: string, payload: unknown = {}): Promise<T> => api.backend.call<T>(`ai.${method}`, payload)
  offs.push(api.commands.register({
    id: 'harness-list',
    labelKey: 'assistant.harness.command.list',
    label: 'Harnesses: list',
    paletteSafe: false,
    sideEffect: 'read',
    usage: 'harness list',
    run: () => invokeAiData<{ harnesses: HarnessPackageStatus[] }>('listHarnesses'),
    formatCli: (value) => {
      const harnesses = (value as { harnesses: HarnessPackageStatus[] }).harnesses
      return harnesses.length ? harnesses.map((item) => `${item.id}\t${t(`assistant.harness.${item.ready ? 'ready' : item.enabled ? 'error' : 'disabled'}`)}\t${item.name}\t${t('assistant.harness.cases', { count: item.caseCount ?? 0 })}`).join('\n') : t('assistant.harness.noHarnesses')
    }
  }))

  offs.push(api.commands.register({
    id: 'harness-inspect',
    labelKey: 'assistant.harness.command.inspect',
    label: 'Harnesses: inspect package and recent runs',
    paletteSafe: false,
    sideEffect: 'read',
    usage: 'harness inspect <id>',
    input: { schema: inputSchema({ id: string }, ['id']), parse: (raw) => ({ id: asStr((raw as Record<string, unknown>)?.id) }), fromCli: (args) => ({ id: args[0] }) },
    run: async (input) => {
      const { id } = input as { id: string }
      if (!id) throw new Error(t('assistant.harness.usage', { value: 'harness inspect <id>' }))
      const [pkg, history] = await Promise.all([
        invokeAiData<{ package: HarnessPackageSnapshot | null }>('readHarnessPackage', { id }),
        invokeAiData<{ runs: HarnessRun[] }>('listHarnessRuns', { id, limit: 10 })
      ])
      return { package: pkg.package, runs: history.runs }
    }
  }))

  offs.push(api.commands.register({
    id: 'harness-reload',
    labelKey: 'assistant.harness.command.reload',
    label: 'Harnesses: reload',
    paletteSafe: false,
    sideEffect: 'write',
    usage: 'harness reload',
    run: async () => ({ value: await invokeAiData<{ harnesses: HarnessPackageStatus[] }>('reloadHarnesses'), revert: null }),
    formatCli: (value) => t('assistant.harness.reloaded', { count: (value as { harnesses: HarnessPackageStatus[] }).harnesses.filter((item) => item.ready).length })
  }))

  offs.push(api.commands.register({
    id: 'harness-run',
    labelKey: 'assistant.harness.command.run',
    label: 'Harnesses: run',
    paletteSafe: false,
    sideEffect: 'write',
    usage: 'harness run <id> <provider:model>... [--connection <id>] [--use-cache] [--concurrency <n>]',
    input: {
      schema: inputSchema({ id: string, targets: { type: 'array', items: string, minItems: 1 }, connectionId: string, useCache: { type: 'boolean' }, concurrency: { type: ['number', 'string'] } }, ['id', 'targets']),
      parse: (raw) => raw,
      fromCli: (args, flags) => ({ id: args[0], targets: args.slice(1), connectionId: flags.connection, useCache: flags['use-cache'] === true, concurrency: flags.concurrency })
    },
    run: async (input) => {
      const value = input as { id?: string; targets?: string[]; connectionId?: unknown; useCache?: boolean; concurrency?: unknown }
      if (!value.id || !value.targets?.length) throw new Error(t('assistant.harness.usage', { value: 'harness run <id> <provider:model>...' }))
      const targets: HarnessTarget[] = value.targets.map((entry) => {
        const split = entry.indexOf(':')
        if (split <= 0 || split === entry.length - 1) throw new Error(t('assistant.harness.invalidTarget', { value: entry }))
        return { provider: entry.slice(0, split), model: entry.slice(split + 1), ...(typeof value.connectionId === 'string' ? { connectionId: value.connectionId } : {}) }
      })
      return { value: await invokeAiData<{ run: HarnessRun }>('runHarness', { id: value.id, targets, options: { useCache: value.useCache === true, concurrency: clampLimit(value.concurrency, 3) } }), revert: null }
    },
    formatCli: (value) => t('assistant.harness.started', { id: (value as { run: HarnessRun }).run.id })
  }))

  offs.push(api.commands.register({
    id: 'harness-cancel',
    labelKey: 'assistant.harness.command.cancel',
    label: 'Harnesses: cancel run',
    paletteSafe: false,
    sideEffect: 'write',
    usage: 'harness cancel <run-id>',
    input: { schema: inputSchema({ runId: string }, ['runId']), parse: (raw) => raw, fromCli: (args) => ({ runId: args[0] }) },
    run: (input) => {
      const runId = asStr((input as Record<string, unknown>)?.runId)
      if (!runId) throw new Error(t('assistant.harness.usage', { value: 'harness cancel <run-id>' }))
      return invokeAiData('cancelHarnessRun', { runId }).then((value) => ({ value, revert: null }))
    }
  }))

  offs.push(api.commands.register({
    id: 'harness-history',
    labelKey: 'assistant.harness.command.history',
    label: 'Harnesses: run history',
    paletteSafe: false,
    sideEffect: 'read',
    usage: 'harness history <id> [--limit <n>]',
    input: { schema: inputSchema({ id: string, limit: { type: ['number', 'string'] } }, ['id']), parse: (raw) => raw, fromCli: (args, flags) => ({ id: args[0], limit: flags.limit }) },
    run: (input) => {
      const value = input as { id?: string; limit?: unknown }
      if (!value.id) throw new Error(t('assistant.harness.usage', { value: 'harness history <id> [--limit <n>]' }))
      return invokeAiData<{ runs: HarnessRun[] }>('listHarnessRuns', { id: value.id, limit: clampLimit(value.limit, 20) })
    },
    formatCli: (value) => (value as { runs: HarnessRun[] }).runs.map((run) => `${run.id}\t${run.status}\t${new Date(run.startedAt).toISOString()}`).join('\n') || t('assistant.harness.noRuns')
  }))

  offs.push(api.commands.register({
    id: 'harness-clear-cache',
    labelKey: 'assistant.harness.command.clear-cache',
    label: 'Harnesses: clear cache',
    paletteSafe: false,
    sideEffect: 'write',
    usage: 'harness clear-cache <id>',
    input: { schema: inputSchema({ id: string }, ['id']), parse: (raw) => raw, fromCli: (args) => ({ id: args[0] }) },
    run: (input) => {
      const id = asStr((input as Record<string, unknown>)?.id)
      if (!id) throw new Error(t('assistant.harness.usage', { value: 'harness clear-cache <id>' }))
      return invokeAiData('clearHarnessCache', { id }).then((value) => ({ value, revert: null }))
    },
    formatCli: () => t('assistant.harness.cleared')
  }))

  return () => offs.forEach((off) => off())
}
