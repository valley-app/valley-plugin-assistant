import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
import type { GuardPolicy } from '@valley/plugin-sdk/guard/types'
import { valleyCancellationOf } from '@valley/plugin-sdk/valleyCancellation'
import { ToolRegistry } from '../src/backend/tools/registry'
import { ToolExecutor } from '../src/backend/tools/executor'
import { AssistantRepository } from '../src/backend/persistence/repositories'
import { datasetFixture } from './backendDatasetFixture'
import type { ToolEffect, ToolExecutionContext } from '../src/contracts/tools'
import { commandResult } from '../src/backend/tools/commandResult'

function fixture(effect: ToolEffect = 'retryable') {
  const policy: GuardPolicy = { defaultWrite: { decision: 'allow' }, tools: {}, commands: {}, files: { visitMode: 'allow-all-except-blocked', defaultRead: { decision: 'allow' }, defaultWrite: { decision: 'allow' }, allowedToVisit: ['**'], allowedToWrite: ['**'], blocked: [], readOverrides: {}, writeOverrides: {} }, dangerousMode: { enabled: false, scope: 'off' }, pluginPresets: {} }
  const execute = vi.fn(async () => 'saved'), approve = vi.fn(async () => true), state = vi.fn(async () => {})
  const cancellation = new AbortController()
  const context: ToolExecutionContext = { conversationId: 'chat', runId: 'run', planning: false, state, approve, operation: { cancellation: valleyCancellationOf(cancellation), api: { policy: { read: async () => policy } } } as unknown as PluginBackendOperationContext }
  const registry = new ToolRegistry().register({ name: 'write_note', description: 'Write a note', group: 'general', parameters: z.object({ text: z.string() }), output: z.string(), requiredCapabilities: [], effect, timeoutMs: 1000,
    guardTargets: () => [{ kind: 'tool', id: 'write_note', sideEffect: 'write' }, { kind: 'file', path: 'Notes/secret.md', sideEffect: 'write', fileOperation: 'write' }], execute })
  const repository = new AssistantRepository(datasetFixture())
  const executor = new ToolExecutor(registry, repository)
  const call = { id: 'write', name: 'write_note', arguments: { text: 'Note' } }
  return { policy, context, cancellation, execute, approve, state, repository, executor, call, registry }
}
afterEach(() => vi.useRealTimers())

describe('backend Guard layers', () => {
  it('honors a persisted chat block passed into the execution context', async () => {
    const test = fixture()
    test.context.guardLayers = { chat: { tools: { write_note: { decision: 'deny' } } } }
    expect(await test.executor.execute(test.call, test.context)).toMatchObject({ success: false, error: { code: 'GUARD_DENIED' } })
    expect(test.execute).not.toHaveBeenCalled(); expect(test.approve).not.toHaveBeenCalled()
    expect(await test.repository.get('tool_executions', 'run:write')).toMatchObject({ state: 'COMPLETED' })
  })
  it('cannot widen a global denial through chat or channel permission', async () => {
    const test = fixture(); test.policy.tools.write_note = { decision: 'deny' }
    test.context.guardLayers = { channel: { tools: { write_note: { decision: 'allow' } } }, chat: { tools: { write_note: { decision: 'allow' } } } }
    expect(await test.executor.execute(test.call, test.context)).toMatchObject({ success: false, error: { code: 'GUARD_DENIED' } })
    expect(test.execute).not.toHaveBeenCalled()
  })
  it('uses explicit pre-approval only when the higher policy permits it', async () => {
    const test = fixture(); test.policy.tools.write_note = { decision: 'confirm', allowPreApproval: true }
    test.context.guardLayers = { chat: { tools: { write_note: { decision: 'allow' } } } }
    expect(await test.executor.execute(test.call, test.context)).toEqual({ success: true, value: 'saved' })
    expect(test.approve).not.toHaveBeenCalled()
    const next = fixture(); next.policy.tools.write_note = { decision: 'confirm', allowPreApproval: false }; next.context.guardLayers = test.context.guardLayers
    await next.executor.execute(next.call, next.context)
    expect(next.approve).toHaveBeenCalledOnce()
  })
  it('keeps channel path blocks even when the chat and Full access permit writing', async () => {
    const test = fixture(); test.policy.dangerousMode = { enabled: true, scope: 'session' }
    test.context.guardLayers = { channel: { blocked: ['Notes/**'] }, chat: { fileWriteOverrides: { '**': { decision: 'allow' } } } }
    expect(await test.executor.execute(test.call, test.context)).toMatchObject({ success: false, error: { code: 'GUARD_DENIED' } })
    expect(test.execute).not.toHaveBeenCalled()
  })
  it('rechecks policy after approval and rejects changed permission before executing', async () => {
    const test = fixture(); test.policy.tools.write_note = { decision: 'confirm' }
    test.approve.mockImplementationOnce(async () => { test.policy.tools.write_note = { decision: 'deny' }; return true })
    expect(await test.executor.execute(test.call, test.context)).toMatchObject({ success: false, error: { code: 'GUARD_DENIED' } })
    expect(test.state).toHaveBeenCalledWith('AWAITING_APPROVAL'); expect(test.execute).not.toHaveBeenCalled()
  })
  it('rejects mutations in plan mode before approval or durable dispatch', async () => {
    const test = fixture(); test.context.planning = true
    expect(await test.executor.execute(test.call, test.context)).toMatchObject({ success: false, error: { code: 'PLAN_REQUIRES_APPROVAL' } })
    expect(test.execute).not.toHaveBeenCalled(); expect(test.approve).not.toHaveBeenCalled()
    expect(await test.repository.get('tool_executions', 'run:write')).toBeNull()
  })
  it('does not replay a completed approved call or reuse its identity for changed input', async () => {
    const test = fixture(); test.policy.tools.write_note = { decision: 'confirm' }
    await test.executor.execute(test.call, test.context)
    expect(await test.executor.execute(test.call, test.context)).toEqual({ success: true, value: 'saved' })
    expect(test.execute).toHaveBeenCalledOnce(); expect(test.approve).toHaveBeenCalledOnce()
    expect(await test.executor.execute({ ...test.call, arguments: { text: 'Changed' } }, test.context)).toMatchObject({ success: false, error: { code: 'CALL_ID_CONFLICT' } })
  })
  it('cancels before effect dispatch when an approval completes after cancellation', async () => {
    const test = fixture(); test.policy.tools.write_note = { decision: 'confirm' }
    test.approve.mockImplementationOnce(async () => { test.cancellation.abort(); return true })
    await expect(test.executor.execute(test.call, test.context)).rejects.toThrow()
    expect(test.execute).not.toHaveBeenCalled()
  })
  it('persists an unknown timeout without joining a never-settling effect, including after restart', async () => {
    vi.useFakeTimers()
    const test = fixture('non-idempotent')
    test.execute.mockImplementation(() => new Promise(() => {}))
    const task = test.executor.execute(test.call, test.context)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await task).toMatchObject({ success: false, error: { code: 'TIMEOUT', outcomeUnknown: true } })
    expect(await test.repository.get('tool_executions', 'run:write')).toMatchObject({ state: 'UNKNOWN' })
    const restored = new ToolExecutor(test.registry, test.repository)
    expect(await restored.execute({ ...test.call, id: 'retry' }, { ...test.context, runId: 'new-run' })).toMatchObject({ success: false, error: { code: 'UNKNOWN_PREVIOUS_OUTCOME', outcomeUnknown: true } })
    expect(test.execute).toHaveBeenCalledOnce()
  })
  it('returns promptly on Stop and reconciles late success without replaying or changing conversation state', async () => {
    vi.useFakeTimers()
    const test = fixture('non-idempotent')
    let resolve!: (value: string) => void
    test.execute.mockImplementation(() => new Promise(done => { resolve = done }))
    const task = test.executor.execute(test.call, test.context)
    await vi.advanceTimersByTimeAsync(0)
    test.cancellation.abort()
    expect(await task).toMatchObject({ success: false, error: { code: 'INTERRUPTED', outcomeUnknown: true } })
    const states = test.state.mock.calls.length
    resolve('saved once')
    await vi.advanceTimersByTimeAsync(0)
    expect(await test.repository.get('tool_executions', 'run:write')).toMatchObject({ state: 'COMPLETED', result: { success: true, value: 'saved once' } })
    expect(test.state).toHaveBeenCalledTimes(states)
    expect(await test.executor.execute(test.call, test.context)).toEqual({ success: true, value: 'saved once' })
    expect(test.execute).toHaveBeenCalledOnce()
  })
  it('retains accepted host execution identity for a late uncertain result', async () => {
    vi.useFakeTimers()
    const test = fixture('non-idempotent')
    let resolve!: () => void
    test.execute.mockImplementation(async () => {
      await new Promise<void>(done => { resolve = done })
      return commandResult({ id: 'effect-1', command: 'note.write', revision: 3, status: 'uncertain' }) as string
    })
    const task = test.executor.execute(test.call, test.context)
    await vi.advanceTimersByTimeAsync(1000)
    await task
    resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(await test.repository.get('tool_executions', 'run:write')).toMatchObject({ state: 'UNKNOWN', result: { success: false, error: { outcomeUnknown: true, execution: { id: 'effect-1', command: 'note.write', status: 'uncertain', revision: 3 } } } })
  })
  it('returns input the host rejected before running as a recoverable error, but keeps a rejection after acceptance unknown', async () => {
    const test = fixture('non-idempotent')
    test.execute.mockRejectedValueOnce(Object.assign(new Error('Invalid command input: / must NOT have additional properties'), { code: 'INVALID_INPUT' }))
    const rejected = await test.executor.execute(test.call, test.context)
    expect(rejected).toMatchObject({ success: false, error: { code: 'INVALID_INPUT', recoverable: true } })
    expect(rejected.success || rejected.error.outcomeUnknown).toBeFalsy()
    expect(await test.repository.get('tool_executions', 'run:write')).toMatchObject({ state: 'COMPLETED' })
    const accepted = fixture('non-idempotent')
    accepted.execute.mockRejectedValueOnce(Object.assign(new Error('Invalid command input'), { code: 'INVALID_INPUT', execution: { id: 'effect-2', command: 'note.write', status: 'failed', revision: 2 } }))
    expect(await accepted.executor.execute(accepted.call, accepted.context)).toMatchObject({ success: false, error: { code: 'INVALID_INPUT', recoverable: false, outcomeUnknown: true } })
  })
})
