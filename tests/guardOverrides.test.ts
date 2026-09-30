import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
import type { GuardPolicy } from '@valley/plugin-sdk/guard/types'
import { valleyCancellationOf } from '@valley/plugin-sdk/valleyCancellation'
import { ToolRegistry } from '../src/backend/tools/registry'
import { ToolExecutor } from '../src/backend/tools/executor'
import { AssistantRepository } from '../src/backend/persistence/repositories'
import { datasetFixture } from './backendDatasetFixture'
import type { ToolExecutionContext } from '../src/contracts/tools'

function fixture() {
  const policy: GuardPolicy = { defaultWrite: { decision: 'allow' }, tools: {}, commands: {}, files: { visitMode: 'allow-all-except-blocked', defaultRead: { decision: 'allow' }, defaultWrite: { decision: 'allow' }, allowedToVisit: ['**'], allowedToWrite: ['**'], blocked: [], readOverrides: {}, writeOverrides: {} }, dangerousMode: { enabled: false, scope: 'off' }, pluginPresets: {} }
  const execute = vi.fn(async () => 'saved'), approve = vi.fn(async () => true), state = vi.fn(async () => {})
  const cancellation = new AbortController()
  const context: ToolExecutionContext = { conversationId: 'chat', runId: 'run', planning: false, state, approve, operation: { cancellation: valleyCancellationOf(cancellation), api: { policy: { read: async () => policy } } } as unknown as PluginBackendOperationContext }
  const registry = new ToolRegistry().register({ name: 'write_note', description: 'Write a note', group: 'general', parameters: z.object({ text: z.string() }), output: z.string(), requiredCapabilities: [], effect: 'retryable', timeoutMs: 1000,
    guardTargets: () => [{ kind: 'tool', id: 'write_note', sideEffect: 'write' }, { kind: 'file', path: 'Notes/secret.md', sideEffect: 'write', fileOperation: 'write' }], execute })
  const repository = new AssistantRepository(datasetFixture())
  const executor = new ToolExecutor(registry, repository)
  const call = { id: 'write', name: 'write_note', arguments: { text: 'Note' } }
  return { policy, context, cancellation, execute, approve, state, repository, executor, call }
}

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
})
