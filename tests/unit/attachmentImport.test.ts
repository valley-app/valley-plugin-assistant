import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { valleyCancellationOf } from '@valley/plugin-sdk/valleyCancellation'
import { registerAttachmentImport } from '../../src/backend/engine/attachmentTools'
import { ToolRegistry } from '../../src/backend/tools/registry'
import { ToolExecutor } from '../../src/backend/tools/executor'
import { AssistantRepository } from '../../src/backend/persistence/repositories'
import type { ToolExecutionContext } from '../../src/contracts/tools'
import { datasetFixture } from '../backendDatasetFixture'

const hooks = vi.hoisted(() => ({ importFile: vi.fn(), reference: vi.fn() }))
vi.mock('../../src/backend/attachments', () => ({ importAttachmentFile: hooks.importFile, referenceAttachments: hooks.reference }))
const attachment = { id: 'b05d45cd-0d72-446e-9fdb-66ed917b1bd9', fileName: 'Mechanik Lösung.pdf', mime: 'application/pdf', kind: 'pdf' as const, path: '.valley/plugins/data/assistant/attachment/blob' }
beforeEach(() => { hooks.importFile.mockReset().mockResolvedValue(attachment); hooks.reference.mockReset().mockResolvedValue(undefined) })

function fixture() {
  const registry = new ToolRegistry(), repository = new AssistantRepository(datasetFixture())
  const access = { root: { id: 'root', path: '/vault' }, cwd: '/vault', home: '/home/student' } as Parameters<typeof registerAttachmentImport>[1]['access']
  const options = { conversationId: 'conversation', scopeId: 'scope', planning: false, access }
  registerAttachmentImport(registry, options)
  const invoke = vi.fn(async (_scope: string, command: string) => command === 'authorize.external' ? { authorized: true } : { handle: 'native-file', name: attachment.fileName, size: 1024 })
  const release = vi.fn(async () => {})
  const api = { agent: { invoke }, files: { release }, policy: { read: vi.fn(async () => ({})) } } as unknown as PluginBackendApi
  const context: ToolExecutionContext = { conversationId: options.conversationId, runId: 'run', planning: false, operation: { id: 'operation', api, cancellation: valleyCancellationOf(new AbortController()) }, state: async () => {}, approve: async () => false }
  const executor = new ToolExecutor(registry, repository)
  const call = { id: 'import-call', name: 'attachment_import', arguments: { path: 'generated/Mechanik Lösung.pdf' } }
  return { registry, repository, options, invoke, release, context, executor, call }
}

describe('generated attachment import', () => {
  it('authorizes the local effect before opening an owned handle and returns the original name and MIME', async () => {
    const value = fixture()
    expect(await value.executor.execute(value.call, value.context)).toEqual({ success: true, value: attachment })
    expect(value.invoke.mock.calls.map(call => call[1])).toEqual(['authorize.external', 'projects.openFile'])
    expect(value.invoke).toHaveBeenNthCalledWith(1, 'scope', 'authorize.external', { target: { kind: 'tool', id: 'channel.attachment_import', sideEffect: 'write' }, arguments: { destination: { kind: 'chat', conversationId: 'conversation' }, content: { type: 'attachment_import', rootId: 'root', path: 'generated/Mechanik Lösung.pdf' } } })
    expect(value.invoke).toHaveBeenNthCalledWith(2, 'scope', 'projects.openFile', { rootId: 'root', path: 'generated/Mechanik Lösung.pdf' })
    expect(hooks.importFile).toHaveBeenCalledWith({ fileHandle: 'native-file', fileName: 'Mechanik Lösung.pdf', kind: 'file' }, value.context.operation.api)
    expect(hooks.reference).toHaveBeenCalledWith('conversation', [{ role: 'assistant', content: '', attachmentIds: [attachment.id] }], value.context.operation.api)
    expect(value.release).toHaveBeenCalledWith(['native-file'])
    expect(await new ToolExecutor(value.registry, value.repository).execute(value.call, value.context)).toEqual({ success: true, value: attachment })
    expect(hooks.importFile).toHaveBeenCalledOnce()
  })

  it('denies planning at the executor and source even if a caller bypasses the executor', async () => {
    const value = fixture()
    expect(value.registry.descriptors(new Set(), true).map(tool => tool.name)).not.toContain('attachment_import')
    expect(await value.executor.execute(value.call, { ...value.context, planning: true })).toMatchObject({ success: false, error: { code: 'PLAN_REQUIRES_APPROVAL' } })
    value.options.planning = true
    await expect(value.registry.get('attachment_import')!.execute(value.call.arguments, value.context)).rejects.toThrow('Plan mode forbids')
    expect(value.invoke).not.toHaveBeenCalled(); expect(hooks.importFile).not.toHaveBeenCalled()
  })

  it('honors a core Plan or Guard denial before opening a file when source flags are bypassed', async () => {
    const value = fixture()
    value.invoke.mockRejectedValueOnce(new Error('PLAN_MODE_DENIED'))
    await expect(value.registry.get('attachment_import')!.execute(value.call.arguments, value.context)).rejects.toThrow('PLAN_MODE_DENIED')
    expect(value.invoke).toHaveBeenCalledOnce()
    expect(hooks.importFile).not.toHaveBeenCalled(); expect(value.release).not.toHaveBeenCalled()
  })

  it.each([{ rootId: 'another-root', path: 'file.pdf' }, { path: '../outside.pdf' }])('rejects paths outside the bound root before any authorization or import', async input => {
    const value = fixture()
    await expect(value.registry.get('attachment_import')!.execute(input, value.context)).rejects.toThrow(/access/)
    expect(value.invoke).not.toHaveBeenCalled(); expect(hooks.importFile).not.toHaveBeenCalled()
  })

  it('does not accept caller-supplied native handles or another conversation', async () => {
    const value = fixture()
    expect(await value.executor.execute({ ...value.call, arguments: { ...value.call.arguments, fileHandle: 'foreign-handle' } }, value.context)).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } })
    await expect(value.registry.get('attachment_import')!.execute(value.call.arguments, { ...value.context, conversationId: 'another' })).rejects.toThrow('another conversation')
    expect(value.invoke).not.toHaveBeenCalled()
  })

  it.each(['import', 'reference'])('releases the native handle after %s failure without a second copy', async failure => {
    const value = fixture()
    if (failure === 'import') hooks.importFile.mockRejectedValueOnce(new Error('Unknown or expired native handle'))
    else hooks.reference.mockRejectedValueOnce(new Error('Conversation deleted'))
    const result = await value.executor.execute(value.call, value.context)
    expect(result).toMatchObject({ success: false, error: { outcomeUnknown: true } })
    expect(value.release).toHaveBeenCalledOnce()
    expect(value.release).toHaveBeenCalledWith(['native-file'])
    expect(await value.executor.execute({ ...value.call, id: 'another-call' }, value.context)).toMatchObject({ success: false, error: { code: 'UNKNOWN_PREVIOUS_OUTCOME' } })
    expect(hooks.importFile).toHaveBeenCalledOnce()
  })

  it('releases a returned handle even when its metadata is invalid', async () => {
    const value = fixture()
    value.invoke.mockResolvedValueOnce({ authorized: true }).mockResolvedValueOnce({ handle: 'native-file', name: '', size: -1 })
    await expect(value.registry.get('attachment_import')!.execute(value.call.arguments, value.context)).rejects.toThrow()
    expect(value.release).toHaveBeenCalledWith(['native-file'])
    expect(hooks.importFile).not.toHaveBeenCalled()
  })
})
