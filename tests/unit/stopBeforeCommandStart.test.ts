import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginBackendOperationContext } from '@valley/plugin-sdk'

const hooks = vi.hoisted(() => ({ writable: async () => {}, activity: [] as Array<{ state: string }> }))
vi.mock('../../src/backend/attachments', () => ({ assertChatWritable: () => hooks.writable() }))
vi.mock('../../src/backend/projects', () => ({ executionContext: async () => ({ root: { id: 'root', path: '/vault', projectId: 'project' }, roots: [{ id: 'root', path: '/vault' }] }), executionFile: (_access: unknown, rootId: string, path: string) => ({ rootId, path }) }))
vi.mock('../../src/backend/activity', () => ({ appendActivity: async (_chatId: string, activity: { state: string }) => { hooks.activity.push(activity) }, activityRequest: async () => 'output-ref', outputChunks: (text: string) => [text] }))
vi.mock('../../src/backend/runtime', () => ({ backendClosing: () => false, backendApi: () => { throw new Error('unused') } }))

import { executeProjectCommand } from '../../src/backend/projectExecution'
import { markChatStopping, stopChatProcesses } from '../../src/backend/processScopes'

const rootId = '6f1c2b8e-2d4a-4c1e-9a43-0b7d5e3f9a10'
let api: { process: Record<string, ReturnType<typeof vi.fn>> }
const context = (signal = new AbortController().signal) => ({ id: 'operation', cancellation: signal, api } as unknown as PluginBackendOperationContext)
const command = (chatId: string, signal?: AbortSignal) => executeProjectCommand({ chatId, rootId, command: 'printf note > note.md' }, context(signal))
const gate = () => { let open!: () => void; const ready = new Promise<void>(resolve => { open = resolve }); hooks.writable = () => ready; return open }

beforeEach(() => {
  hooks.writable = async () => {}
  hooks.activity = []
  api = { process: {
    onEvent: vi.fn(() => () => {}),
    start: vi.fn(async ({ id }: { id: string }) => ({ id })),
    wait: vi.fn(async (id: string) => ({ id, exitCode: 0, signal: null, durationMs: 1, cancelled: false })),
    cancel: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {})
  } }
})

describe('Stop before a project command starts', () => {
  it('starts the command when nothing stops the conversation', async () => {
    await expect(command('chat-plain')).resolves.toMatchObject({ text: expect.stringContaining('"exitCode":0') })
    expect(api.process.start).toHaveBeenCalledOnce()
  })

  it('never starts a command whose conversation was stopped between dispatch and start', async () => {
    const open = gate()
    const running = command('chat-stopped')
    await vi.waitFor(() => expect(api.process.onEvent).toHaveBeenCalled())
    await stopChatProcesses('chat-stopped', false, api as never)
    open()
    await expect(running).rejects.toMatchObject({ code: 'COMMAND_CANCELLED', outcome: 'not-applied', retryable: false })
    expect(api.process.start).not.toHaveBeenCalled()
    expect(hooks.activity.at(-1)?.state).toBe('cancelled')
  })

  it('never starts a command while a Stop for its conversation is still being processed', async () => {
    const open = gate()
    const running = command('chat-stopping')
    await vi.waitFor(() => expect(api.process.onEvent).toHaveBeenCalled())
    const done = markChatStopping('chat-stopping')
    open()
    await expect(running).rejects.toMatchObject({ code: 'COMMAND_CANCELLED', outcome: 'not-applied' })
    done()
    expect(api.process.start).not.toHaveBeenCalled()
    await expect(command('chat-stopping')).resolves.toBeDefined()
    expect(api.process.start).toHaveBeenCalledOnce()
  })

  it('never starts a command whose turn was aborted before start', async () => {
    const open = gate(), controller = new AbortController()
    const running = command('chat-aborted', controller.signal)
    await vi.waitFor(() => expect(api.process.onEvent).toHaveBeenCalled())
    controller.abort()
    open()
    await expect(running).rejects.toMatchObject({ outcome: 'not-applied' })
    expect(api.process.start).not.toHaveBeenCalled()
  })
})
