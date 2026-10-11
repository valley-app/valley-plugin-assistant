// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginCredentialApi } from '@valley/plugin-sdk/pluginNetwork'
import { valleyCancellationOf } from '@valley/plugin-sdk/valleyCancellation'
import type { PluginBackendOperationContext, PluginBackendApi } from '@valley/plugin-sdk'
import { initBackend } from '../src/backend/runtime'
import { releaseFileAccess, readFile, writeFile, storageLocation } from '../src/backend/filesystem'
import { readChat, saveChat, appendMemory, readMemory } from '../src/backend/store'
import { getCredential, channelKey, setSecret, hasSecret } from '../src/backend/secrets'
import { register } from '../src/backend/index'
import { AssistantRuntime } from '../src/backend/engine/service'
import type { CoordinatorPorts } from '../src/backend/engine/coordinator'
import { dispatchTelegram } from '../src/backend/channels/adapters/telegram'
import { dispatchWhatsApp } from '../src/backend/channels/adapters/whatsapp'
import { activityRequest, appendActivity } from '../src/backend/activity'
import { importAttachment, discardAttachment, resumeAttachmentCleanup, importTransferredAttachments } from '../src/backend/attachments'
import { deleteChat, renameChat, saveGuardOverrides, listChats, clearChat, rebuildChatSearch } from '../src/backend/threads'
import { projectRequest, resumeProjectCleanup, executionContext, executionFile } from '../src/backend/projects'
import { datasetFixture } from './backendDatasetFixture'
import { encodePluginBackendOperationValue, decodePluginBackendOperationValue } from '@valley/plugin-sdk/pluginBackendOperations'
import { transportValue } from '../src/backend/transport'
const files = new Map<string, Uint8Array>()
const grants = new Map<string, string>()
const revisions = new Map<string, { content: string | null; revision: number }>()
const snapshot = (path: string) => {
  const content = files.has(path) ? decoder.decode(files.get(path)) : null
  const previous = revisions.get(path)
  const value = { content, revision: previous ? previous.revision + Number(previous.content !== content) : content === null ? 0 : 1 }
  revisions.set(path, value)
  return value
}
const operation = (owner: PluginBackendOperationContext['api'] = api as unknown as PluginBackendApi): PluginBackendOperationContext => ({ id: crypto.randomUUID(), api: owner, cancellation: valleyCancellationOf(new AbortController()) })
let ledger: Uint8Array | null = null
let writing: Uint8Array[] = []
let readOffset = 0
const encoder = new TextEncoder(), decoder = new TextDecoder()
const locate = (location: { handle: string; path: string }) => `${grants.get(location.handle)}/${location.path}`.replace(/\/$/, '')
const credentials = { presence: vi.fn<PluginCredentialApi['presence']>(async () => 'stored'), state: vi.fn<PluginCredentialApi['state']>(async () => 'ok'), handle: vi.fn<PluginCredentialApi['handle']>(async () => 'opaque-handle'), set: vi.fn<PluginCredentialApi['set']>(), delete: vi.fn<PluginCredentialApi['delete']>() }
const rpc = { handleOperation: vi.fn<PluginBackendApi['rpc']['handleOperation']>(() => () => {}), handle: vi.fn<PluginBackendApi['rpc']['handle']>(() => () => {}), emit: vi.fn() }
const api: { agent: Pick<PluginBackendApi['agent'], 'captureTarget'>; process: Pick<PluginBackendApi['process'], 'shutdown'>; settings: Pick<PluginBackendApi['settings'], 'get'>; data: PluginBackendApi['data']; ai: Pick<PluginBackendApi['ai'], 'onStream' | 'cancel' | 'connections' | 'models'>; policy: Pick<PluginBackendApi['policy'], 'read' | 'checkFile'>; rpc: typeof rpc; storage: Pick<PluginBackendApi['storage'], 'readDocument'|'writeDocument'|'writeDocuments'|'open'|'close'|'stat'|'readBytes'|'writeBytes'|'write'|'mkdir'|'move'|'remove'|'list'>; credentials: typeof credentials; sealed: Pick<PluginBackendApi['sealed'], 'openRead'|'readChunk'|'beginWrite'|'writeChunk'|'commitWrite'|'close'> } = {
  agent: { captureTarget: vi.fn(async () => null) },
  process: { shutdown: async () => {} }, settings: { get: () => ({}) }, data: datasetFixture(), ai: { onStream: () => () => {}, cancel: async () => true, connections: async () => [], models: async () => [] },
  policy: { checkFile: async () => {}, read: async () => ({ defaultWrite: { decision: 'confirm' }, tools: {}, commands: {}, files: { visitMode: 'allow-all-except-blocked', defaultRead: { decision: 'allow' }, defaultWrite: { decision: 'confirm' }, allowedToVisit: ['**'], allowedToWrite: [], blocked: [], readOverrides: {}, writeOverrides: {} }, dangerousMode: { enabled: false, scope: 'off' }, pluginPresets: {} }) },
  rpc,
  storage: {
    readDocument: async location => { const value = snapshot(locate(location)); return { content: value.content ?? '', revision: value.revision } },
    writeDocument: async (location, input) => { const result = await api.storage.writeDocuments([{ location, ...input }]); return { revision: result.revisions[0] } },
    writeDocuments: async entries => {
      const values = entries.map(entry => ({ ...entry, path: locate(entry.location), previous: snapshot(locate(entry.location)) }))
      for (const value of values) if (value.expectedRevision !== value.previous.revision) throw Object.assign(new Error('Revision conflict'), { code: 'REVISION_CONFLICT', status: 409, currentRevision: value.previous.revision })
      return { revisions: values.map(value => {
        if (value.content === null) files.delete(value.path)
        else files.set(value.path, encoder.encode(value.content))
        return snapshot(value.path).revision
      }) }
    },
    open: vi.fn<PluginBackendApi['storage']['open']>(async ({ area, path, mode }) => { const handle = crypto.randomUUID(); grants.set(handle, area === 'metadata' ? `.valley/${path}` : path); return { handle, path, kind: 'directory', mode } }),
    close: async (handle: string) => { grants.delete(handle) },
    stat: async (location) => { const path = locate(location), value = files.get(path); return value ? { name: path.split('/').at(-1) ?? '', kind: 'file', size: value.length, mtimeMs: 1 } : null },
    readBytes: async (location, { offset = 0, maxBytes = 1024 } = {}) => { const value = files.get(locate(location)); if (!value) throw new Error('missing'); const bytes = value.subarray(offset, offset + maxBytes); return { base64: Buffer.from(bytes).toString('base64'), nextOffset: offset + bytes.length, done: offset + bytes.length >= value.length } },
    write: async (location, text, append) => { const path = locate(location), previous = append ? files.get(path) ?? new Uint8Array() : new Uint8Array(); const value = encoder.encode(text), next = new Uint8Array(previous.length + value.length); next.set(previous); next.set(value, previous.length); files.set(path, next) },
    writeBytes: async (location, base64, append) => { const path = locate(location), previous = append ? files.get(path) ?? new Uint8Array() : new Uint8Array(); const value = Buffer.from(base64, 'base64'), next = new Uint8Array(previous.length + value.length); next.set(previous); next.set(value, previous.length); files.set(path, next) },
    mkdir: async () => {},
    move: async (from, to) => { const value = files.get(locate(from)); if (!value) throw new Error('missing'); files.set(locate(to), value); files.delete(locate(from)) },
    remove: async (location, options) => { const target = locate(location); for (const file of files.keys()) if (file === target || options?.recursive && file.startsWith(target + '/')) files.delete(file) },
    list: async (location) => { const prefix = locate(location) + '/'; return [...new Set([...files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length).split('/')[0]))].map((name) => ({ name, kind: files.has(prefix + name) ? 'file' : 'directory', size: 0, mtimeMs: 1 })) }
  },
  credentials,
  sealed: {
    openRead: async () => { readOffset = 0; return ledger ? { handle: 'read', bytes: ledger.length } : null },
    readChunk: async (_handle, maximum) => { const bytes = ledger!.subarray(readOffset, readOffset + Math.min(maximum ?? 1024, 7)); readOffset += bytes.length; return { base64: Buffer.from(bytes).toString('base64'), done: readOffset >= ledger!.length } },
    beginWrite: async () => { writing = []; return 'write' },
    writeChunk: async (_handle, base64) => { writing.push(Buffer.from(base64, 'base64')) },
    commitWrite: async () => { ledger = Buffer.concat(writing) }, close: async () => {}
  }
}
beforeEach(() => { files.clear(); grants.clear(); revisions.clear(); ledger = null; api.data = datasetFixture(); vi.clearAllMocks(); initBackend(api as unknown as PluginBackendApi) })
afterEach(async () => { await releaseFileAccess() })
describe('Assistant package persistence', () => {
  it('times out while backend initialization is stalled and fences the late scoped submission', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const restore = vi.spyOn(AssistantRuntime.prototype, 'restore').mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const submit = vi.spyOn(AssistantRuntime.prototype, 'submit')
    const dispose = register(api as unknown as PluginBackendApi)
    try {
      const handler = rpc.handleOperation.mock.calls.find(([method]) => method === 'session.submit')![1]
      const result = Promise.resolve(handler({ id: 'initializing', conversationId: 'startup-chat', text: 'Create fern.md', thread: { id: 'startup-chat', title: 'Fern', createdAt: 1, updatedAt: 1, messages: [] } }, operation()))
      const failed = expect(result).rejects.toThrow('initializing the conversation for 10 seconds')
      await vi.advanceTimersByTimeAsync(10000); await failed
      expect(submit).not.toHaveBeenCalled()
      release(); await vi.advanceTimersByTimeAsync(0)
      expect(submit).not.toHaveBeenCalled()
      expect(api.agent.captureTarget).not.toHaveBeenCalled()
    } finally { release?.(); await dispose(); restore.mockRestore(); submit.mockRestore(); vi.useRealTimers() }
  })

  it('captures the authenticated submission target before returning admission and runs with the durable backend owner', async () => {
    const target = crypto.randomUUID(), captureTarget = vi.fn(async () => ({ reference: target }))
    const owner = { ...api, agent: { captureTarget } } as unknown as PluginBackendOperationContext['api']
    let finish!: () => void
    const run = vi.spyOn(AssistantRuntime.prototype as unknown as { run: CoordinatorPorts['run'] }, 'run').mockImplementation(async (_session, turn, controls) => {
      expect(turn?.targetReference).toBe(target)
      expect(controls.api).toBe(api)
      await new Promise<void>(resolve => { finish = resolve })
      await controls.message({ role: 'assistant', content: 'Opened.' })
    })
    const dispose = register(api as unknown as PluginBackendApi)
    try {
      expect(rpc.handle.mock.calls.some(([method]) => method === 'session.submit')).toBe(false)
      const handler = rpc.handleOperation.mock.calls.find(([method]) => method === 'session.submit')![1]
      const input = { id: 'ui-turn', conversationId: 'ui-chat', text: 'Open the calendar app', thread: { id: 'ui-chat', title: 'Calendar', createdAt: 1, updatedAt: 1, messages: [] } }
      await expect(handler({ ...input, targetReference: 'forged' }, operation(owner))).rejects.toThrow()
      expect(captureTarget).not.toHaveBeenCalled()
      const session = await handler(input, operation(owner))
      expect(encodePluginBackendOperationValue(session)).toBeTypeOf('string')
      expect(captureTarget).toHaveBeenCalledOnce()
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      finish()
    } finally { finish?.(); await dispose(); run.mockRestore() }
  })

  it('delivers queued, streaming and terminal sessions plus saved chats through the actual host encoder', async () => {
    const wire = (value: unknown) => decodePluginBackendOperationValue(encodePluginBackendOperationValue(value))
    const id = 'wire-session'
    await saveChat('/vault', { id, title: 'Wire session', createdAt: 1, updatedAt: 1, messages: [], profileId: undefined })
    const observed: unknown[] = []
    rpc.emit.mockImplementation((name, value) => { if (name === 'session.changed') observed.push(wire(value)) })
    let finish!: () => void
    const run = vi.spyOn(AssistantRuntime.prototype as unknown as { run: CoordinatorPorts['run'] }, 'run').mockImplementation(async (_session, _turn, controls) => {
      await controls.state('INFERRING')
      await controls.stream('Note created')
      await new Promise<void>(resolve => { finish = resolve })
      await controls.message({ role: 'assistant', content: 'Note created.', toolCalls: undefined })
    })
    const dispose = register(api as unknown as PluginBackendApi)
    try {
      const command = (name: string) => rpc.handleOperation.mock.calls.find(([method]) => method === name)![1]
      const read = (name: string) => rpc.handle.mock.calls.find(([method]) => method === name)![1]
      const result = Promise.resolve(command('command.session.submit')({ id: 'wire-turn', conversationId: id, text: 'Create one note' }, operation()))
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      expect(wire(await command('command.session.snapshot')({ conversationId: id }, operation()))).toMatchObject({ state: 'INFERRING', streamingText: 'Note created' })
      expect(wire(await read('session.snapshot')({ conversationId: id }))).toMatchObject({ state: 'INFERRING' })
      finish()
      expect(wire(await result)).toMatchObject({ state: 'IDLE', streamingText: '', thread: { messages: [{ content: 'Note created.' }] } })
      expect(observed.at(-1)).toMatchObject({ session: { state: 'IDLE' }, event: { type: 'finished' } })
      expect(wire(await command('command.readChat')({ id }, operation()))).toMatchObject({ thread: { messages: [{ content: 'Note created.' }] } })
      expect(wire(await read('ai.readChat')({ id }))).toMatchObject({ thread: { messages: [{ content: 'Note created.' }] } })
      expect(wire(await readChat('/vault', id))).toMatchObject({ id })
    } finally { finish?.(); await dispose(); run.mockRestore(); rpc.emit.mockReset() }
  })

  it('omits optional object fields without coercing invalid transport values or changing saved values', () => {
    const value = { absent: undefined, nested: { absent: undefined, zero: 0, empty: '', no: false, nil: null }, array: [{ optional: undefined, text: 'Fern' }] }
    const encoded = encodePluginBackendOperationValue(transportValue(value))
    expect(decodePluginBackendOperationValue(encoded)).toEqual({ nested: { zero: 0, empty: '', no: false, nil: null }, array: [{ text: 'Fern' }] })
    expect(Object.hasOwn(value, 'absent')).toBe(true)
    expect(transportValue(undefined)).toBeUndefined()
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    for (const invalid of [NaN, Infinity, 1n, () => {}, Symbol('invalid'), [undefined], new Array(1), new Date(), new Map(), cycle, Object.defineProperty({}, 'hidden', { value: 'value' }), { get value() { throw new Error('getter must not run') } }]) {
      expect(() => transportValue(invalid)).toThrow(/Assistant response/)
    }
  })

  it('resolves external and home paths in ordinary Chat only with Full access', async () => {
    await saveChat('/vault', { id: 'native-chat', title: 'Code', createdAt: 1, updatedAt: 1, messages: [{ role: 'user', content: 'Create a fern study.' }] })
    const root = { id: crypto.randomUUID(), projectId: 'access-full', path: '/', name: 'full' }
    const access = vi.fn(async () => ({ mode: 'full' as const, root, cwd: '/fixture/home', home: '/fixture/home' }))
    const context = await executionContext('native-chat', { ...api, projects: { access } } as unknown as PluginBackendApi)
    const dispose = register({ ...api, projects: { access } } as unknown as PluginBackendApi)
    try {
      const request = rpc.handle.mock.calls.find(([method]) => method === 'projects.request')![1]
      expect(await request({ method: 'execution', payload: { chatId: 'native-chat' } })).toMatchObject({ mode: 'full', roots: [root], cwd: '/fixture/home' })
    } finally { await dispose() }
    expect(context.project).toBeUndefined()
    expect(executionFile(context, root.id, '~/Desktop/fern.py')).toEqual({ rootId: root.id, path: 'fixture/home/Desktop/fern.py' })
    expect(executionFile(context, root.id, '/fixture/code/fern.py')).toEqual({ rootId: root.id, path: 'fixture/code/fern.py' })
    const vault = { ...context, mode: 'vault' as const, root: { ...root, path: '/vault' }, cwd: '/vault' }
    expect(() => executionFile(vault, root.id, '~/Desktop/fern.py')).toThrow('Full access')
    expect(() => executionFile(vault, root.id, '../external/fern.py')).toThrow('Full access')
    expect(executionFile(vault, root.id, 'fern.py')).toEqual({ rootId: root.id, path: 'fern.py' })
    expect(() => executionFile(context, crypto.randomUUID(), 'fern.py')).toThrow('access changed')
  })

  it('lists the latest conversational preview without tool output and clears it with history', async () => {
    const thread = { id: 'preview', title: 'Moss survey', createdAt: 1, updatedAt: 2, messages: [
      { role: 'user' as const, content: 'Describe the canopy.' },
      { role: 'assistant' as const, content: 'Moss retains\nwater.' },
      { role: 'tool' as const, content: 'Internal tool result' }
    ] }
    await saveChat('/vault', thread)
    expect(await listChats('/vault')).toEqual([expect.objectContaining({ preview: 'Moss retains water.' })])
    await saveChat('/vault', { ...thread, messages: [] })
    expect(await listChats('/vault')).toEqual([])
  })
  it('indexes full conversation content and tracks rename, clear, deletion and cache rebuilding', async () => {
    const thread = { id: 'search-chat', title: 'Canopy survey', createdAt: 1, updatedAt: 2, messages: [
      { role: 'user' as const, content: 'Find the rare fern.' },
      { role: 'assistant' as const, content: 'It grows under the canopy.' },
      { role: 'tool' as const, content: 'Hidden tool payload' },
      { role: 'system' as const, content: 'Hidden system instruction' }
    ] }
    const search = api.data.dataset('chat_search')
    await saveChat('/vault', thread)
    expect(await search.get({ id: thread.id })).toMatchObject({ title: 'Canopy survey', content: 'Find the rare fern.\nIt grows under the canopy.' })
    await renameChat('/vault', thread.id, 'Fern habitat')
    expect(await search.get({ id: thread.id })).toMatchObject({ title: 'Fern habitat' })
    await search.delete({ id: thread.id })
    await search.upsert({ id: 'stale', title: '', content: '', preview: '', updatedAt: 0 })
    await rebuildChatSearch('/vault')
    expect(await search.get({ id: thread.id })).toMatchObject({ title: 'Fern habitat' })
    expect(await search.get({ id: 'stale' })).toBeNull()
    await clearChat('/vault', thread.id)
    expect(await search.get({ id: thread.id })).toBeNull()
    await deleteChat('/vault', thread.id)
    expect(await search.get({ id: thread.id })).toBeNull()
  })
  it('persists queued input and its attachment ownership before sending', async () => {
    const attachment = await importAttachment({ fileName: 'moss.txt', kind: 'file', bytes: new TextEncoder().encode('Moss inventory') })
    const thread = { id: 'queued-chat', title: 'Queued', createdAt: 1, updatedAt: 1, messages: [], pendingMessages: [{ id: crypto.randomUUID(), text: 'Compare plants', attachments: [attachment] }] }
    await saveChat('/vault', thread)
    expect((await readChat('/vault', thread.id))?.pendingMessages).toEqual(thread.pendingMessages)
    await discardAttachment(attachment.id!)
    expect(files.has(attachment.path)).toBe(true)
  })
  it('saves and clears reasoning effort with conversation metadata', async () => {
    const thread = { id: 'effort', title: 'Fern survey', createdAt: 1, updatedAt: 1, messages: [], reasoningEffort: 'max' as const }
    await saveChat('/vault', thread)
    expect((await readChat('/vault', thread.id))?.reasoningEffort).toBe('max')
    await saveChat('/vault', { ...thread, reasoningEffort: undefined })
    expect((await readChat('/vault', thread.id))?.reasoningEffort).toBeUndefined()
  })
  it('returns empty activity for a new conversation before its first save', async () => {
    expect(await activityRequest('list', { chatId: 'unsaved' })).toEqual({ events: [], done: true, nextOffset: 0 })
    expect(files.size).toBe(0)
    await expect(activityRequest('readOutput', { chatId: 'unsaved', outputRef: 'a'.repeat(64) })).rejects.toThrow('unavailable')
  })
  it('joins accepted RPC persistence before closing storage and rejects new work during unload', async () => {
    const dispose = register(api as unknown as PluginBackendApi)
    let finish!: () => void
    const original = api.storage.writeDocument
    const write = vi.spyOn(api.storage, 'writeDocument').mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { finish = resolve }); return original(...args) })
    const close = vi.spyOn(api.storage, 'close')
    try {
      const save = rpc.handle.mock.calls.find(([method]) => method === 'ai.writeRule')![1]
      const saving = save({ name: 'forest', content: 'Preserve the wetlands', expectedRevision: 0 })
      await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
      let disposed = false
      const draining = dispose().then(() => { disposed = true })
      await expect(save({ name: 'late', content: 'not accepted', expectedRevision: 0 })).rejects.toThrow('closing')
      await Promise.resolve(); expect(disposed).toBe(false)
      const heldGrant = write.mock.calls[0][0].handle
      expect(close).not.toHaveBeenCalledWith(heldGrant)
      finish(); await saving; await draining
      expect([...files.values()].some(value => decoder.decode(value) === 'Preserve the wetlands')).toBe(true)
      expect(close).toHaveBeenCalled()
    } finally { finish?.(); await dispose(); write.mockRestore(); close.mockRestore() }
  })

  it('keeps the real submit command pending through the scoped run and final save', async () => {
    await saveChat('/vault', { id: 'owned-submit', title: 'Owned', createdAt: 1, updatedAt: 1, messages: [] })
    let finish!: () => void
    const run = vi.spyOn(AssistantRuntime.prototype as unknown as { run: CoordinatorPorts['run'] }, 'run').mockImplementation(async (_session, _turn, controls) => {
      expect(controls.api).toBe(owner)
      await new Promise<void>(resolve => { finish = resolve })
      await controls.message({ role: 'assistant', content: 'Owner reply' })
    })
    const owner = { ...api, storage: { ...api.storage, move: vi.fn(api.storage.move) }, data: { ...api.data, transaction: vi.fn(api.data.transaction) } } as unknown as PluginBackendOperationContext['api']
    const dispose = register(api as unknown as PluginBackendApi)
    try {
      const handler = rpc.handleOperation.mock.calls.find(([method]) => method === 'command.session.submit')![1]
      let completed = false
      const result = Promise.resolve(handler({ id: 'owned-turn', conversationId: 'owned-submit', text: 'Hello' }, operation(owner))).then(value => { completed = true; return value })
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      expect(completed).toBe(false)
      finish(); expect(await result).toMatchObject({ state: 'IDLE', thread: { messages: [{ content: 'Owner reply' }] } })
      expect(owner.storage.move).toHaveBeenCalled()
      expect(owner.data.transaction).toHaveBeenCalled()
    } finally { finish?.(); await dispose(); run.mockRestore() }
  })

  it('rejects a real chat command after its scoped write is revoked without using background storage', async () => {
    await saveChat('/vault', { id: 'revoked-rename', title: 'Original', createdAt: 1, updatedAt: 1, messages: [] })
    const dispose = register(api as unknown as PluginBackendApi)
    let release!: () => void, revoked = false
    const move = vi.fn<PluginBackendApi['storage']['move']>(async (from, to) => { await new Promise<void>(resolve => { release = resolve }); if (revoked) throw new Error('Operation revoked'); return api.storage.move(from, to) })
    const owner = { ...api, storage: { ...api.storage, move } } as unknown as PluginBackendOperationContext['api']
    try {
      const ready = rpc.handle.mock.calls.find(([method]) => method === 'ai.listChats')![1]
      await ready({})
      const background = vi.spyOn(api.storage, 'move')
      const handler = rpc.handleOperation.mock.calls.find(([method]) => method === 'command.renameChat')![1]
      const result = Promise.resolve(handler({ id: 'revoked-rename', title: 'Denied title' }, operation(owner)))
      await vi.waitFor(() => expect(release).toBeTypeOf('function')); revoked = true; release()
      await expect(result).rejects.toThrow('Operation revoked')
      expect(background).not.toHaveBeenCalled()
      expect((await readChat('/vault', 'revoked-rename'))?.title).toBe('Original')
      background.mockRestore()
    } finally { release?.(); await dispose() }
  })

  it('refuses renaming or pinning a missing, unsafe or deleted conversation as not applied', async () => {
    await saveChat('/vault', { id: 'removed-chat', title: 'Removed', createdAt: 1, updatedAt: 1, messages: [] })
    await deleteChat('/vault', 'removed-chat')
    const dispose = register(api as unknown as PluginBackendApi)
    try {
      await rpc.handle.mock.calls.find(([method]) => method === 'ai.listChats')![1]({})
      const handler = (method: string) => rpc.handleOperation.mock.calls.find(([name]) => name === method)![1]
      for (const [method, input] of [['command.renameChat', { title: 'Ghost' }], ['command.setChatPinned', { pinned: true }]] as const) {
        for (const id of ['missing-chat', '..']) await expect(Promise.resolve(handler(method)({ id, ...input }, operation()))).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND', outcome: 'not-applied', retryable: false })
        await expect(Promise.resolve(handler(method)({ id: 'removed-chat', ...input }, operation()))).rejects.toMatchObject({ message: expect.stringContaining('deleted'), outcome: 'not-applied', retryable: false })
      }
      expect([...files.keys()].filter(file => file.includes('missing-chat') || file.includes('removed-chat'))).toEqual([])
    } finally { await dispose() }
  })

  it('keeps provider sends and endpoint credential rebinding on the scoped operation API', async () => {
    const handle = crypto.randomUUID()
    const credentials = { ...api.credentials, state: vi.fn(async () => 'ok'), handle: vi.fn(async () => handle) }
    let provider: 'telegram' | 'whatsapp' = 'telegram'
    const fetchStream = vi.fn(async () => ({ status: 200, headers: {}, streamId: 'stream' }))
    const readStream = vi.fn(async () => ({ done: true, bodyBase64: btoa(JSON.stringify(provider === 'telegram' ? { ok: true, result: { message_id: 9 } } : { messages: [{ id: 'reply' }] })) }))
    const owner = { ...api, credentials, network: { fetchStream, readStream, cancel: vi.fn(async () => {}) } } as unknown as PluginBackendOperationContext['api']
    expect(await dispatchTelegram(handle, { kind: 'telegram', conversationId: 'chat', chatRef: '9' }, { type: 'text', text: 'Scoped send' }, undefined, owner)).toEqual(['9'])
    expect(fetchStream.mock.calls).toHaveLength(1)
    provider = 'whatsapp'
    await getCredential('/vault', 'channel:fixture', [{ host: 'graph.facebook.com', port: 443, security: 'tls' }], owner)
    expect(await dispatchWhatsApp(handle, { type: 'whatsapp', phoneNumberId: 'number' }, { kind: 'whatsapp', conversationId: 'chat', chatRef: '9' }, { type: 'text', text: 'Scoped send' }, undefined, owner)).toEqual(['reply'])
    expect(credentials.handle).toHaveBeenCalledTimes(2)
    expect(api.credentials.handle).not.toHaveBeenCalled()
    expect(fetchStream).toHaveBeenCalledTimes(2)
    expect(readStream).toHaveBeenCalledTimes(2)
    fetchStream.mockRejectedValueOnce(new Error('Operation revoked'))
    await expect(dispatchTelegram(handle, { kind: 'telegram', conversationId: 'chat', chatRef: '9' }, { type: 'text', text: 'Rejected send' }, undefined, owner)).rejects.toThrow('Operation revoked')
    expect(owner.network.cancel).toHaveBeenCalledOnce()
  })

  it('keeps a held storage grant and physical write on its captured backend API', async () => {
    const originalOpen = vi.mocked(api.storage.open).getMockImplementation()!
    let finish!: () => void
    vi.mocked(api.storage.open).mockImplementationOnce(async input => { await new Promise<void>(resolve => { finish = resolve }); return originalOpen(input) })
    const held = writeFile('/vault/.valley/plugins/data/assistant/old.txt', 'Old accepted text')
    await vi.waitFor(() => expect(api.storage.open).toHaveBeenCalledOnce())
    const replacement = { storage: { open: vi.fn(), write: vi.fn(), close: vi.fn() } } as unknown as PluginBackendApi
    initBackend(replacement)
    finish(); await held
    expect(files.get('.valley/plugins/data/assistant/old.txt')).toEqual(encoder.encode('Old accepted text'))
    expect(replacement.storage.write).not.toHaveBeenCalled()
    await releaseFileAccess(api as unknown as PluginBackendApi)
    expect(replacement.storage.close).not.toHaveBeenCalled()
    initBackend(api as unknown as PluginBackendApi)
  })





  it('seeds only its own Markdown metadata and opens no vault-wide grant at startup', async () => {
    const dispose = register(api as unknown as PluginBackendApi)
    try {
      const listChats = rpc.handle.mock.calls.find(([method]) => method === 'ai.listChats')![1]
      await listChats({})
      expect(api.storage.open).toHaveBeenCalledWith({ area: 'metadata', path: 'plugins/data/assistant', kind: 'directory', mode: 'read' })
      expect(api.storage.open).toHaveBeenCalledWith({ area: 'metadata', path: 'plugins/data/assistant', kind: 'directory', mode: 'write' })
      expect(vi.mocked(api.storage.open).mock.calls.every(([request]) => request.area === 'metadata' && request.path === 'plugins/data/assistant')).toBe(true)
      expect(files.has('.valley/plugins/data/assistant/settings.md')).toBe(true)
      expect(files.has('.valley/plugins/data/assistant/instructions/global.md')).toBe(true)
    } finally { await dispose() }
  })

  it('reads legacy conversations when Markdown migration writes are denied', async () => {
    const directory = '.valley/plugins/data/assistant/chats/read-only'
    files.set(`${directory}/settings.json`, encoder.encode(JSON.stringify({ id: 'read-only', title: 'Canopy', createdAt: 1, updatedAt: 2, attachmentParser: 'parser-a' })))
    files.set(`${directory}/thread.jsonl`, encoder.encode(JSON.stringify({ role: 'user', content: 'Forest inventory' }) + '\n'))
    const original = vi.mocked(api.storage.open).getMockImplementation()!
    vi.mocked(api.storage.open).mockImplementation(async request => { if (request.mode === 'write') throw new Error('Write access denied'); return original(request) })
    try {
      expect(await readChat('/vault', 'read-only')).toMatchObject({ title: 'Canopy', attachmentParser: 'parser-a', messages: [{ role: 'user', content: 'Forest inventory' }] })
      expect(files.has(`${directory}/settings.md`)).toBe(false)
      expect(files.size).toBe(2)
      await expect(saveChat('/vault', { id: 'read-only', title: 'Replacement', createdAt: 1, updatedAt: 3, messages: [] })).rejects.toThrow('Write access denied')
      expect(await readChat('/vault', 'read-only')).toMatchObject({ title: 'Canopy' })
    } finally { vi.mocked(api.storage.open).mockImplementation(original) }
  })

  it('keeps saved history readable when write access is denied and upgrades only for a write', async () => {
    const file = '/vault/.valley/plugins/data/assistant/chats/old/thread.jsonl'
    files.set('.valley/plugins/data/assistant/chats/old/thread.jsonl', encoder.encode('saved history'))
    expect(await readFile(file)).toBe('saved history')
    expect(await readFile(file)).toBe('saved history')
    expect(api.storage.open).toHaveBeenCalledTimes(1)
    expect(api.storage.open).toHaveBeenLastCalledWith({ area: 'metadata', path: 'plugins/data/assistant', kind: 'directory', mode: 'read' })

    vi.mocked(api.storage.open).mockRejectedValueOnce(new Error('Write access denied'))
    await expect(writeFile(file, 'replacement')).rejects.toThrow('Write access denied')
    expect(await readFile(file)).toBe('saved history')
    expect(api.storage.open).toHaveBeenCalledTimes(2)
    expect(api.storage.open).toHaveBeenLastCalledWith({ area: 'metadata', path: 'plugins/data/assistant', kind: 'directory', mode: 'write' })

    await writeFile(file, 'new history')
    expect(await readFile(file)).toBe('new history')
    expect(api.storage.open).toHaveBeenCalledTimes(3)
    expect(api.storage.open).toHaveBeenLastCalledWith({ area: 'metadata', path: 'plugins/data/assistant', kind: 'directory', mode: 'write' })
  })

  it('reads existing chats and appends only new messages at the same saved paths', async () => {
    const directory = '.valley/plugins/data/assistant/chats/old'
    files.set(`${directory}/settings.json`, encoder.encode(JSON.stringify({ id: 'old', title: 'Blüten', createdAt: 1, updatedAt: 2 })))
    const initial = JSON.stringify({ role: 'user', content: 'Grüsse ä ö ü ß' }) + '\n'
    files.set(`${directory}/thread.jsonl`, encoder.encode(initial))
    const thread = await readChat('/vault', 'old')
    expect(thread?.messages[0].content).toBe('Grüsse ä ö ü ß')
    thread!.messages.push({ role: 'assistant', content: 'Antwort' })
    await saveChat('/vault', thread!)
    expect(decoder.decode(files.get(`${directory}/thread.jsonl`))).toBe(initial + JSON.stringify(thread!.messages[1]) + '\n')
    await appendMemory('/vault', thread!, { id: 'one', summary: 'Blüten erinnern', createdAt: 3 })
    expect((await readMemory('/vault', 'old'))[0].summary).toBe('Blüten erinnern')
    expect([...files.keys()].some((path) => path.includes('plugins/assistant'))).toBe(false)
  })
  it('preserves Unicode across text chunks and arbitrary binary attachment bytes', async () => {
    const text = 'a'.repeat(256 * 1024 - 1) + '🪷 ä ö ü ß'
    await writeFile('/vault/.valley/plugins/data/assistant/large.txt', text)
    expect(await readFile('/vault/.valley/plugins/data/assistant/large.txt')).toBe(text)
    const binary = Uint8Array.from([0, 255, 128, 42])
    await writeFile('/vault/.valley/plugins/data/assistant/attachment.bin', binary)
    expect(files.get('.valley/plugins/data/assistant/attachment.bin')).toEqual(binary)
    await expect(storageLocation('/vault/unapproved/secret')).rejects.toThrow('no storage binding')
  })
  it('keeps channel credentials in device-local broker storage and returns only opaque handles', async () => {
    const endpoint = { host: 'api.example.test', port: 443, security: 'tls' as const }
    const key = channelKey('custom')
    expect(await hasSecret('/vault', key)).toBe(true)
    expect(credentials.presence).toHaveBeenCalledWith(key, { file: 'credentials.json', valueField: 'value' })
    expect(credentials.state).not.toHaveBeenCalled()
    expect(credentials.handle).not.toHaveBeenCalled()
    expect(await getCredential('/vault', key, [endpoint])).toBe('opaque-handle')
    expect(credentials.state).toHaveBeenCalledOnce()
    const source = credentials.handle.mock.calls[0][1]!
    expect(source.store).toEqual({ file: 'credentials.json', valueField: 'value' })
    expect(source.endpoints).toEqual([endpoint])
    await setSecret('/vault', key, 'new-key', [endpoint])
    expect(credentials.set).toHaveBeenCalledWith(key, 'new-key', [endpoint], { file: 'credentials.json', valueField: 'value' })
    expect(files.size).toBe(0)
  })

  it('removes only chat-owned attachments after the last reference, preserving project and unknown files', async () => {
    const shared = await importAttachment({ fileName: 'shared.png', kind: 'image', bytes: encoder.encode('shared') })
    const unique = await importAttachment({ fileName: 'unique.txt', kind: 'file', bytes: encoder.encode('unique'), folder: 'My inbox' })
    const thread = (id: string, ids: string[]) => ({ id, title: id, createdAt: 1, updatedAt: 1, messages: [{ role: 'user' as const, content: 'See attachments', attachmentIds: ids }] })
    await saveChat('/vault', thread('first', [shared.id!, unique.id!]))
    await saveChat('/vault', thread('second', [shared.id!]))
    files.set('project/generated.ts', encoder.encode('project source'))
    files.set('My inbox/uncertain.txt', encoder.encode('unknown legacy owner'))
    await deleteChat('/vault', 'first')
    expect(files.has(unique.path)).toBe(false)
    expect(files.has(shared.path)).toBe(true)
    expect(await readChat('/vault', 'first')).toBeNull()
    await deleteChat('/vault', 'second')
    expect(files.has(shared.path)).toBe(false)
    expect(files.has('project/generated.ts')).toBe(true)
    expect(files.has('My inbox/uncertain.txt')).toBe(true)
    await expect(saveChat('/vault', thread('first', []))).rejects.toThrow('deleted')
    await expect(renameChat('/vault', 'first', 'revived')).rejects.toThrow('deleted')
    await expect(appendMemory('/vault', { id: 'first' }, { id: 'late', summary: 'late memory', createdAt: 1 })).rejects.toThrow('deleted')
    await expect(saveGuardOverrides('/vault', { id: 'first' }, {})).rejects.toThrow('deleted')
  })
  it('retries interrupted deletion and preserves changed attachments instead of guessing ownership', async () => {
    const attachment = await importAttachment({ fileName: 'flora.txt', kind: 'file', bytes: encoder.encode('original') })
    await saveChat('/vault', { id: 'cleanup', title: 'cleanup', createdAt: 1, updatedAt: 1, messages: [{ role: 'user', content: '', attachmentIds: [attachment.id!] }] })
    const original = api.storage.remove
    const remove = vi.spyOn(api.storage, 'remove').mockImplementationOnce(async () => { throw new Error('Temporary filesystem failure') })
    await expect(deleteChat('/vault', 'cleanup')).rejects.toThrow('Temporary filesystem failure')
    remove.mockImplementation(original)
    await resumeAttachmentCleanup()
    expect(files.has(attachment.path)).toBe(false)
    expect(await api.data.dataset('chat_cleanup').get({ id: 'cleanup' })).toMatchObject({ state: 'done' })
    remove.mockRestore()
    const modified = await importAttachment({ fileName: 'modified.txt', kind: 'file', bytes: encoder.encode('original') })
    files.set(modified.path, encoder.encode('user edits'))
    await expect(discardAttachment(modified.id!)).rejects.toThrow('Attachment changed')
    expect(decoder.decode(files.get(modified.path))).toBe('user edits')
  })
  it('discards an unsent upload without deleting an attachment already referenced by a chat', async () => {
    const draft = await importAttachment({ fileName: 'draft.txt', kind: 'file', bytes: encoder.encode('draft') })
    await discardAttachment(draft.id!)
    expect(files.has(draft.path)).toBe(false)
    const saved = await importAttachment({ fileName: 'saved.txt', kind: 'file', bytes: encoder.encode('saved') })
    await saveChat('/vault', { id: 'saved', title: 'saved', createdAt: 1, updatedAt: 1, messages: [{ role: 'user', content: '', attachmentIds: [saved.id!] }] })
    await discardAttachment(saved.id!)
    expect(files.has(saved.path)).toBe(true)
  })

  it('recovers interrupted activity once, keeps nested identities and reads complete redacted output in pages', async () => {
    await saveChat('/vault', { id: 'activity', title: 'activity', createdAt: 1, updatedAt: 1, messages: [] })
    const event = { runId: 'run', callId: 'call', name: 'command', state: 'running' as const, timestamp: 1, arguments: { command: 'build' } }
    await appendActivity('activity', event)
    await appendActivity('activity', { ...event, callId: 'nested', parentCallId: 'call', state: 'failed', result: { exitCode: 7 } })
    const text = 'Grüße '.repeat(14000) + 'sk-' + 's'.repeat(24)
    const outputRef = await activityRequest('output', { chatId: 'activity', runId: 'run', callId: 'call', text, first: true })
    await releaseFileAccess()
    initBackend({ ...api } as unknown as PluginBackendApi)
    const page = await activityRequest('list', { chatId: 'activity' }) as { events: Array<{ callId: string; state: string; parentCallId?: string }> }
    expect(page.events.at(-1)).toMatchObject({ callId: 'call', state: 'cancelled' })
    expect(page.events.find(event => event.callId === 'nested')).toMatchObject({ parentCallId: 'call', state: 'failed' })
    expect(await activityRequest('list', { chatId: 'activity' })).toEqual(page)
    let offset = 0; const chunks: Buffer[] = []
    for (;;) {
      const output = await activityRequest('readOutput', { chatId: 'activity', outputRef, offset }) as { base64: string; nextOffset: number; done: boolean }
      chunks.push(Buffer.from(output.base64, 'base64')); offset = output.nextOffset
      if (output.done) break
    }
    expect(chunks.length).toBeGreaterThan(1)
    expect(Buffer.concat(chunks).toString()).toBe('Grüße '.repeat(14000) + '[redacted]')
  })

  it('retains large redacted arguments and results across paged activity reopening', async () => {
    await saveChat('/vault', { id: 'large-activity', title: 'large', createdAt: 1, updatedAt: 1, messages: [] })
    const content = 'Blüten 🌱 '.repeat(20000) + 'sk-' + 'k'.repeat(24)
    await appendActivity('large-activity', { runId: 'run', callId: 'large', name: 'project_write_file', state: 'completed', timestamp: 2, arguments: { content }, result: { content } })
    const page = await activityRequest('list', { chatId: 'large-activity' }) as { events: Array<{ argumentsRef: string; resultRef: string; arguments: object }> }
    const event = page.events[0]
    expect(JSON.stringify(event.arguments).length).toBeLessThan(10000)
    for (const outputRef of [event.argumentsRef, event.resultRef]) {
      const chunks: Buffer[] = []; let offset = 0
      for (;;) { const result = await activityRequest('readOutput', { chatId: 'large-activity', outputRef, offset }) as { base64: string; nextOffset: number; done: boolean }; chunks.push(Buffer.from(result.base64, 'base64')); offset = result.nextOffset; if (result.done) break }
      expect(JSON.parse(Buffer.concat(chunks).toString()).content).toBe('Blüten 🌱 '.repeat(20000) + '[redacted]')
    }
  })
  it('imports transferred references through datasets and retries without granting deletion ownership', async () => {
    const id = crypto.randomUUID(), path = '.valley/plugins/data/assistant/transfer-records.json'
    const record = { id, path: 'custom/flower.txt', fileName: 'flower.txt', mime: '', kind: 'file', owned: false, sha256: 'a'.repeat(64), state: 'ready', createdAt: 1 }
    files.set(path, encoder.encode(JSON.stringify({ version: 1, attachments: [record], references: [{ attachmentId: id, chatId: 'one' }, { attachmentId: id, chatId: 'two' }] })))
    const source = files.get(path)!
    await importTransferredAttachments()
    expect(files.has(path)).toBe(false)
    expect(await api.data.dataset('attachments').get({ id })).toMatchObject({ owned: false, path: 'custom/flower.txt' })
    files.set(path, source)
    await importTransferredAttachments()
    expect(await api.data.dataset('attachment_refs').count()).toBe(2)
  })
  it('deletes project organization with restart recovery while retaining conversations and attachments', async () => {
    const roots = [{ id: crypto.randomUUID(), projectId: '', path: '/external/project', name: 'project' }]
    const revoke = vi.fn(async () => {})
    const projectApi = { ...api, projects: { roots: async () => roots, pick: async () => roots[0], revoke } }
    initBackend(projectApi as unknown as PluginBackendApi)
    const project = await projectRequest('create', { name: 'Research' }) as { id: string }
    roots[0].projectId = project.id
    await projectRequest('addFolder', { id: project.id })
    const attachment = await importAttachment({ fileName: 'flower.txt', kind: 'file', bytes: encoder.encode('Blüten') })
    const thread = { id: 'project-chat', projectId: project.id, title: 'Research', createdAt: 1, updatedAt: 1, messages: [{ role: 'user' as const, content: 'hello', attachmentIds: [attachment.id!] }] }
    await saveChat('/vault', thread)
    revoke.mockRejectedValueOnce(new Error('temporary revoke failure'))
    await expect(projectRequest('delete', { id: project.id })).rejects.toThrow('temporary revoke failure')
    expect(await projectRequest('list', {})).toEqual([])
    await resumeProjectCleanup()
    await saveChat('/vault', thread)
    expect((await readChat('/vault', thread.id))?.projectId).toBeUndefined()
    expect((await readChat('/vault', thread.id))?.messages).toEqual(thread.messages)
    expect(files.has(attachment.path)).toBe(true)
    expect(await api.data.dataset('projects').count()).toBe(0)
    expect(await api.data.dataset('attachment_refs').count()).toBe(1)
  })

  it('answers command deleteChat and clearChat with an undo receipt that rewrites the exact chat bytes and drops the deletion records', async () => {
    const dispose = register(api as unknown as PluginBackendApi)
    const operationOf = (method: string) => rpc.handleOperation.mock.calls.find(([name]) => name === method)![1]
    const envelope = (id: string, expectedRevision?: unknown) => ({ input: { id }, execution: { id: crypto.randomUUID(), correlationId: crypto.randomUUID(), expectedRevision } })
    const chatFiles = (id: string) => new Map([...files].filter(([file]) => file.includes(`/chats/${id}/`)).map(([file, bytes]) => [file, Buffer.from(bytes).toString('base64')]))
    const rows = async (id: string) => ({ cleanup: await api.data.dataset('chat_cleanup').get({ id }), deletion: await api.data.dataset('conversation_deletions').get({ id }), search: await api.data.dataset('chat_search').get({ id }) })
    try {
      await rpc.handle.mock.calls.find(([method]) => method === 'ai.listChats')![1]({})
      for (const name of ['deleteChat', 'clearChat'] as const) {
        const id = `undo-${name}`
        await saveChat('/vault', { id, title: 'Fern äöü', createdAt: 1, updatedAt: 2, messages: [{ role: 'user', content: 'Moss\r\nfern' }, { role: 'assistant', content: 'Canopy äöü' }] })
        await appendMemory('/vault', { id }, { id: 'memory', summary: 'Waters moss', createdAt: 3 })
        await rebuildChatSearch('/vault')
        const before = chatFiles(id), baseline = await rows(id)
        expect(before.size).toBeGreaterThanOrEqual(3)
        const result = await Promise.resolve(operationOf(`command.${name}`)(envelope(id), operation())) as { value: unknown; undo: { snapshot: unknown; expectedRevision: string; affectedEntities: string[] } }
        expect(result.value).toBeNull()
        expect(result.undo.affectedEntities).toEqual([id])
        expect(chatFiles(id)).not.toEqual(before)
        expect(await operationOf('command.chat.revision')(envelope(id), operation())).toBe(result.undo.expectedRevision)
        expect(await operationOf('command.chat.undo')({ snapshot: result.undo.snapshot, execution: { id: crypto.randomUUID(), correlationId: crypto.randomUUID(), expectedRevision: result.undo.expectedRevision } }, operation())).toBeNull()
        expect(chatFiles(id)).toEqual(before)
        expect(await rows(id)).toEqual(baseline)
        expect(await readChat('/vault', id)).toMatchObject({ id, messages: [{ content: 'Moss\r\nfern' }, { content: 'Canopy äöü' }] })
        const again = await Promise.resolve(operationOf(`command.${name}`)(envelope(id), operation())) as typeof result
        await saveChat('/vault', { id: `${id}-other`, title: 'Other', createdAt: 1, updatedAt: 1, messages: [] })
        if (name === 'clearChat') await renameChat('/vault', id, 'Newer title')
        else { await api.data.dataset('chat_cleanup').delete({ id }); await saveChat('/vault', { id, title: 'Recreated', createdAt: 5, updatedAt: 5, messages: [] }) }
        const newer = chatFiles(id)
        await expect(Promise.resolve(operationOf('command.chat.undo')({ snapshot: again.undo.snapshot, execution: { expectedRevision: again.undo.expectedRevision } }, operation()))).rejects.toMatchObject({ code: 'UNDO_CONFLICT_STALE_TARGET', outcome: 'not-applied' })
        expect(chatFiles(id)).toEqual(newer)
      }
    } finally { await dispose() }
  })

  it('offers no chat receipt for attachments, missing chats or a forged snapshot and keeps the private ai rpc unchanged', async () => {
    const dispose = register(api as unknown as PluginBackendApi)
    const operationOf = (method: string) => rpc.handleOperation.mock.calls.find(([name]) => name === method)![1]
    const envelope = (id: string) => ({ input: { id }, execution: { id: crypto.randomUUID(), correlationId: crypto.randomUUID() } })
    try {
      await rpc.handle.mock.calls.find(([method]) => method === 'ai.listChats')![1]({})
      await saveChat('/vault', { id: 'with-attachment', title: 'Fern', createdAt: 1, updatedAt: 1, messages: [{ role: 'user', content: 'Moss' }] })
      await api.data.dataset('attachment_refs').upsert({ attachmentId: crypto.randomUUID(), chatId: 'with-attachment' })
      expect(await operationOf('command.clearChat')(envelope('with-attachment'), operation())).toEqual({ value: null })
      expect(await operationOf('command.deleteChat')(envelope('missing-chat'), operation())).toEqual({ value: null })
      await expect(Promise.resolve(operationOf('command.chat.undo')({ snapshot: { id: '..', entries: [{ path: '../escape', kind: 'file', base64: '' }] }, execution: { expectedRevision: 'x' } }, operation()))).rejects.toThrow()
      expect([...files.keys()].some(file => file.includes('escape'))).toBe(false)
      for (const name of ['deleteChat', 'clearChat']) {
        const id = `rpc-${name}`
        await saveChat('/vault', { id, title: 'Rpc', createdAt: 1, updatedAt: 1, messages: [{ role: 'user', content: 'Moss' }] })
        await rpc.handle.mock.calls.find(([method]) => method === `ai.${name}`)![1]({ id })
      }
      expect(await readChat('/vault', 'rpc-deleteChat')).toBeNull()
      expect((await readChat('/vault', 'rpc-clearChat'))?.messages).toEqual([])
    } finally { await dispose() }
  })

  it('restores the exact harness cache entries cleared through the private ai rpc only while the folder is unchanged', async () => {
    const dispose = register(api as unknown as PluginBackendApi)
    const call = (method: string, input: unknown) => rpc.handle.mock.calls.find(([name]) => name === `ai.${method}`)![1](input)
    const cache = '/vault/.valley/plugins/data/assistant/cache/evaluations/fixture'
    const cached = () => new Map([...files].filter(([file]) => file.includes('cache/evaluations/fixture/')).map(([file, bytes]) => [file, Buffer.from(bytes).toString('base64')]))
    try {
      await call('listChats', {})
      await writeFile(`${cache}/a.json`, '{"createdAt":1,"value":{"text":"Moss äöü"}}')
      await writeFile(`${cache}/b.json`, new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))
      const before = cached(), snapshot = await call('captureHarnessCache', { id: 'fixture' })
      expect(await call('captureHarnessCache', { id: 'absent' })).toBeNull()
      await call('clearHarnessCache', { id: 'fixture' })
      expect(cached().size).toBe(0)
      const expectedRevision = await call('harnessCacheRevision', { id: 'fixture' }) as string
      expect(await call('restoreHarnessCache', { snapshot, expectedRevision })).toEqual({ ok: true })
      expect(cached()).toEqual(before)
      await call('clearHarnessCache', { id: 'fixture' })
      await writeFile(`${cache}/c.json`, '{}')
      await expect(Promise.resolve(call('restoreHarnessCache', { snapshot, expectedRevision }))).rejects.toMatchObject({ code: 'UNDO_CONFLICT_STALE_TARGET', outcome: 'not-applied' })
      expect([...cached().keys()].map(file => file.split('/').at(-1))).toEqual(['c.json'])
    } finally { await dispose() }
  })

  it('forgets exactly one sealed-test conversation turn: chat bytes, coordinator session, its rows and the new instruction snapshot', async () => {
    const describe = vi.fn(async (command: string) => command === 'ai:usage-forget' ? { id: command, location: 'core', effect: 'write' } : null)
    const sealedApi = { ...api, commands: { describe } } as unknown as PluginBackendApi
    const id = 'sealed-turn', chatFiles = () => new Map([...files].filter(([file]) => file.includes(`/chats/${id}/`)).map(([file, bytes]) => [file, Buffer.from(bytes).toString('base64')]))
    const snapshot = (rowId: string, conversationId: string) => ({ id: rowId, conversationId, state: 'VALID', revision: 0, payload: { hash: rowId }, updatedAt: 1 })
    const run = vi.spyOn(AssistantRuntime.prototype as unknown as { run: CoordinatorPorts['run'] }, 'run').mockImplementation(async (_session, _turn, controls) => {
      await api.data.transaction([{ dataset: 'instruction_snapshots', operation: 'upsert', values: snapshot('shared-hash', id) }, { dataset: 'instruction_snapshots', operation: 'upsert', values: snapshot('new-hash', id) }])
      await controls.message({ role: 'assistant', content: 'Moos-Antwort äöü' })
    })
    const dispose = register(sealedApi)
    const operationOf = (method: string) => rpc.handleOperation.mock.calls.find(([name]) => name === method)?.[1]
    const conversationRows = async () => Object.fromEntries(await Promise.all(['sessions', 'session_events', 'turn_queue', 'conversation_deletions'].map(async dataset => [dataset, await api.data.dataset(dataset).count({ conversationId: id })])))
    try {
      await saveChat('/vault', { id, title: 'Farn äöü', createdAt: 1, updatedAt: 2, messages: [{ role: 'user', content: 'Moss\r\nfern' }] })
      await api.data.transaction([{ dataset: 'instruction_snapshots', operation: 'upsert', values: snapshot('shared-hash', 'other-chat') }])
      await rebuildChatSearch('/vault')
      expect(operationOf('test.captureSession')).toBeUndefined()
      expect(await rpc.handle.mock.calls.find(([name]) => name === 'test.sealed')![1]({})).toBe(true)
      const before = chatFiles(), search = await api.data.dataset('chat_search').get({ id }), instructions = (await api.data.dataset('instruction_snapshots').query({})).rows
      const { captureId } = await operationOf('test.captureSession')!({ conversationId: id }, operation(sealedApi as never)) as { captureId: string }
      await operationOf('command.session.submit')!({ id: 'sealed-turn-1', conversationId: id, text: 'Water the moss' }, operation(sealedApi as never))
      expect(await conversationRows()).toMatchObject({ sessions: 1, turn_queue: 1, conversation_deletions: 0 })
      expect(chatFiles()).not.toEqual(before)
      await expect(Promise.resolve(operationOf('test.forgetSession')!({ captureId, conversationId: 'other-chat' }, operation(sealedApi as never)))).rejects.toMatchObject({ code: 'CAPTURE_MISMATCH', outcome: 'not-applied' })
      const result = await operationOf('test.forgetSession')!({ captureId, conversationId: id }, operation(sealedApi as never)) as { turns: string[]; instructions: number }
      expect(result).toMatchObject({ conversationId: id, turns: ['sealed-turn-1'], instructions: 2 })
      expect(chatFiles()).toEqual(before)
      expect(await conversationRows()).toEqual({ sessions: 0, session_events: 0, turn_queue: 0, conversation_deletions: 0 })
      expect((await api.data.dataset('instruction_snapshots').query({})).rows).toEqual(instructions)
      expect(await api.data.dataset('chat_search').get({ id })).toEqual(search)
      expect(await operationOf('command.session.snapshot')!({ conversationId: id }, operation(sealedApi as never))).toBeNull()
      await expect(Promise.resolve(operationOf('test.forgetSession')!({ captureId, conversationId: id }, operation(sealedApi as never)))).rejects.toMatchObject({ code: 'CAPTURE_UNAVAILABLE', outcome: 'not-applied' })
      describe.mockResolvedValue(null)
      await expect(Promise.resolve(operationOf('test.captureSession')!({ conversationId: id }, operation(sealedApi as never)))).rejects.toMatchObject({ code: 'TEST_MODE_REQUIRED', outcome: 'not-applied' })
    } finally { await dispose(); run.mockRestore() }
  })

  it('forgets exactly the sealed-test harness run record and the cache entries it wrote, and refuses a history it cannot attribute', async () => {
    const sealedApi = { ...api, commands: { describe: async (command: string) => ({ id: command, location: 'core' }) } } as unknown as PluginBackendApi
    const dispose = register(sealedApi)
    const operationOf = (method: string) => rpc.handleOperation.mock.calls.find(([name]) => name === method)?.[1]
    const base = '/vault/.valley/plugins/data/assistant', runs = `${base}/evaluation-runs/fixture`, cache = `${base}/cache/evaluations/fixture`
    const tree = () => new Map([...files].filter(([file]) => file.includes('evaluation-runs/') || file.includes('cache/evaluations/')).map(([file, bytes]) => [file, Buffer.from(bytes).toString('base64')]))
    const record = (runId: string) => JSON.stringify({ id: runId, harnessId: 'fixture', status: 'completed' })
    try {
      await rpc.handle.mock.calls.find(([method]) => method === 'ai.listChats')![1]({})
      expect(await rpc.handle.mock.calls.find(([name]) => name === 'test.sealed')![1]({})).toBe(true)
      const older = crypto.randomUUID()
      await writeFile(`${runs}/${older}.json`, record(older)); await writeFile(`${cache}/kept.json`, '{"createdAt":1,"value":{"text":"Moos äöü"}}')
      const before = tree(), { captureId } = await operationOf('test.captureHarness')!({ id: 'fixture' }, operation(sealedApi as never)) as { captureId: string }
      const runId = crypto.randomUUID()
      await writeFile(`${runs}/${runId}.json`, record(runId)); await writeFile(`${cache}/new.json`, '{}'); await writeFile(`${cache}/kept.json`, '{"createdAt":2}')
      expect(await operationOf('test.forgetHarness')!({ captureId, runId }, operation(sealedApi as never))).toEqual({ harnessId: 'fixture', runId, cache: ['kept.json', 'new.json'] })
      expect(tree()).toEqual(before)
      const again = await operationOf('test.captureHarness')!({ id: 'fixture' }, operation(sealedApi as never)) as { captureId: string }, extra = crypto.randomUUID(), other = crypto.randomUUID()
      await writeFile(`${runs}/${extra}.json`, record(extra)); await writeFile(`${runs}/${other}.json`, record(other))
      const changed = tree()
      await expect(Promise.resolve(operationOf('test.forgetHarness')!({ captureId: again.captureId, runId: extra }, operation(sealedApi as never)))).rejects.toMatchObject({ code: 'RUN_MISMATCH', outcome: 'not-applied' })
      expect(tree()).toEqual(changed)
    } finally { await dispose() }
  })

  it('keeps production unchanged: without the sealed-test core descriptor no test operation is registered or applied', async () => {
    for (const commands of [undefined, { describe: async () => null }, { describe: async (command: string) => ({ id: command, location: 'backend' }) }, { describe: async () => { throw new Error('unavailable') } }]) {
      rpc.handleOperation.mockClear(); rpc.handle.mockClear()
      const owner = (commands ? { ...api, commands } : api) as unknown as PluginBackendApi, dispose = register(owner)
      try {
        const operations = () => [...rpc.handleOperation.mock.calls, ...rpc.handle.mock.calls].map(([name]) => name).filter(name => name.startsWith('test.'))
        expect(operations()).toEqual(['test.sealed'])
        expect(await rpc.handle.mock.calls.find(([name]) => name === 'test.sealed')![1]({})).toBe(false)
        expect(operations()).toEqual(['test.sealed'])
      } finally { await dispose() }
    }
  })

})


it('hides empty histories without deleting records and keeps queued or attachment-only chats', async () => {
  const { listChats, rebuildChatSearch } = await import('../src/backend/threads')
  const empty = { id: 'empty-draft', title: 'New chat', createdAt: 1, updatedAt: 1, messages: [] }
  await saveChat('/vault', empty)
  await saveChat('/vault', { ...empty, configurationRevision: undefined, id: 'queued-draft', pendingMessages: [{ id: 'queued', text: 'Describe moss' }] })
  await saveChat('/vault', { ...empty, configurationRevision: undefined, id: 'attachment-chat', messages: [{ role: 'user', content: '', attachmentFiles: [{ fileName: 'fern.png', path: 'fern.png', kind: 'image' }] }] })
  await rebuildChatSearch('/vault')
  expect((await listChats('/vault')).map(chat => chat.id)).toEqual(expect.arrayContaining(['queued-draft', 'attachment-chat']))
  expect((await listChats('/vault')).some(chat => chat.id === empty.id)).toBe(false)
  expect(await readChat('/vault', empty.id)).toMatchObject(JSON.parse(JSON.stringify(empty)))
})
