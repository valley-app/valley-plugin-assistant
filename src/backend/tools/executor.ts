import { resolveGuard, redactSecrets } from '@valley/plugin-sdk'
import { valleyCancellationOf } from '@valley/plugin-sdk/valleyCancellation'
import type { AiToolCall } from '../../types'
import type { ToolExecutionContext, ToolResult } from '../../contracts/tools'
import { AssistantRepository, record } from '../persistence/repositories'
import type { ToolRegistry } from './registry'

interface Execution {
  id: string
  signature: string
  state: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'UNKNOWN'
  result?: ToolResult
  effect: string
}
const stable = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(stable).join(',')}]` : `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
const failure = (code: string, message: string, outcomeUnknown = false): ToolResult => ({ success: false, error: { code, message: redactSecrets(message), recoverable: !outcomeUnknown, ...(outcomeUnknown ? { outcomeUnknown: true } : {}) } })
const terminalCodes = new Set(['TARGET_REQUIRED', 'TARGET_UNAVAILABLE', 'RENDERER_UNAVAILABLE', 'RENDERER_LOST', 'RENDERER_TIMEOUT', 'OWNER_CHANGED', 'OWNER_UNAVAILABLE'])

export class ToolExecutor {
  constructor(private registry: ToolRegistry, private repository: AssistantRepository) {}

  async execute(call: AiToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const tool = this.registry.get(call.name)
    if (!tool) return failure('UNKNOWN_TOOL', `Unknown tool ${call.name}`)
    if (context.planning && tool.effect !== 'read') return failure('PLAN_REQUIRES_APPROVAL', 'Review and explicitly approve the current plan before execution.')
    const parsed = tool.parameters.safeParse(call.arguments)
    if (!parsed.success) return failure('INVALID_INPUT', parsed.error.message)
    const id = `${context.runId}:${call.id}`, signature = stable({ name: call.name, input: parsed.data })
    const previous = await this.repository.get<Execution>('tool_executions', id)
    if (previous?.signature !== undefined && previous.signature !== signature) return failure('CALL_ID_CONFLICT', 'Tool call identity was reused with different input.')
    if (previous?.state === 'COMPLETED') return previous.result!
    if (tool.effect === 'non-idempotent') {
      const records = await this.repository.rows<Execution>('tool_executions', { conversationId: context.conversationId })
      if (records.some(record => record.signature === signature && ['RUNNING', 'UNKNOWN'].includes(record.state))) return failure('UNKNOWN_PREVIOUS_OUTCOME', 'An earlier execution has an unknown outcome. Inspect the destination before attempting another operation.', true)
    }
    const entry: Execution = { id, signature, state: 'PENDING', effect: tool.effect }
    const persist = () => this.repository.data.transaction([{ dataset: 'tool_executions', operation: 'upsert', values: record(id, context.conversationId, entry.state, entry) }])
    await persist()
    const targets = tool.guardTargets(parsed.data)
    const policy = await context.operation.api.policy.read()
    const decisions = targets.map(target => resolveGuard({ caller: 'agent', target }, policy, context.guardLayers ?? {}, policy.dangerousMode, Date.now()))
    let result: ToolResult | undefined
    let settlement: Promise<ToolResult> | undefined
    let interrupted = false
    if (decisions.some(decision => decision.decision === 'deny')) result = failure('GUARD_DENIED', decisions.find(decision => decision.decision === 'deny')!.reason)
    else if (decisions.some(decision => decision.decision === 'confirm')) {
      await context.state('AWAITING_APPROVAL')
      if (!await context.approve(targets, parsed.data)) result = failure('APPROVAL_REJECTED', 'The user declined this operation.')
      else {
        const current = await context.operation.api.policy.read()
        const refreshed = targets.map(target => resolveGuard({ caller: 'agent', target }, current, context.guardLayers ?? {}, current.dangerousMode, Date.now()))
        if (refreshed.some((decision, index) => decision.decision === 'deny' || (decision.decision === 'confirm' && decisions[index].decision === 'allow'))) result = failure('GUARD_DENIED', 'Permission changed while awaiting approval.')
      }
    }
    if (!result) {
      context.operation.cancellation.throwIfAborted()
      entry.state = 'RUNNING'
      await persist()
      await context.state('EXECUTING_TOOLS')
      const controller = new AbortController()
      let interrupt!: (result: ToolResult) => void
      const interruption = new Promise<ToolResult>(resolve => { interrupt = resolve })
      const stop = (code: string, message: string) => { interrupted = true; controller.abort(); interrupt(failure(code, message, tool.effect === 'non-idempotent')) }
      const cancel = () => stop('INTERRUPTED', 'The operation was interrupted. Inspect any pending effect before retrying.')
      context.operation.cancellation.addEventListener('abort', cancel, { once: true })
      if (context.operation.cancellation.aborted) cancel()
      const timer = setTimeout(() => stop('TIMEOUT', 'Tool execution timed out. Inspect any pending effect before retrying.'), Math.min(300000, Math.max(1, tool.timeoutMs)))
      const running = Promise.resolve().then(() => { context.operation.cancellation.throwIfAborted(); return tool.execute(parsed.data, { ...context, operation: { ...context.operation, cancellation: valleyCancellationOf(controller) } }) })
      settlement = running.then(output => ({ success: true, value: tool.output.parse(output) }) as ToolResult).catch(error => {
        const detail = error && typeof error === 'object' ? error as { code?: string; outcome?: string; recoverable?: boolean; execution?: { id: string; command: string; status: string; revision: number } } : {}
        const result = failure(detail.code ?? 'EXECUTION_FAILED', String(error), tool.effect === 'non-idempotent' && detail.outcome !== 'not-applied')
        if (!result.success && (detail.recoverable === false || terminalCodes.has(result.error.code))) result.error.recoverable = false
        if (!result.success && detail.execution) {
          const { id, command, status, revision } = detail.execution
          result.error.execution = { id, command, status, revision }
        }
        return result
      })
      try {
        result = await Promise.race([settlement, interruption])
      } finally { clearTimeout(timer); context.operation.cancellation.removeEventListener('abort', cancel) }
    }
    entry.result = result
    entry.state = !result.success && result.error.outcomeUnknown ? 'UNKNOWN' : 'COMPLETED'
    await persist()
    if (interrupted && settlement && entry.state === 'UNKNOWN') void settlement.then(async settled => {
      entry.result = settled; entry.state = !settled.success && settled.error.outcomeUnknown ? 'UNKNOWN' : 'COMPLETED'
      await persist()
    }).catch(() => {})
    return result
  }
}
