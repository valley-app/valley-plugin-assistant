// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginCredentialApi } from '@valley/plugin-sdk/pluginNetwork'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import { initBackend } from '../src/backend/runtime'
import { releaseFileAccess, readFile, writeFile, storageLocation } from '../src/backend/filesystem'
import { readChat, saveChat, appendMemory, readMemory } from '../src/backend/store'
import { getCredential, channelKey, setSecret } from '../src/backend/secrets'
import { register } from '../src/backend/index'
import { activityRequest, appendActivity } from '../src/backend/activity'
import { importAttachment, discardAttachment, resumeAttachmentCleanup, importTransferredAttachments } from '../src/backend/attachments'
import { deleteChat, renameChat, saveGuardOverrides, listChats, clearChat, rebuildChatSearch } from '../src/backend/threads'
import { projectRequest, resumeProjectCleanup, executionContext, executionFile } from '../src/backend/projects'
import { datasetFixture } from './backendDatasetFixture'
const files = new Map<string, Uint8Array>()
const grants = new Map<string, string>()
let ledger: Uint8Array | null = null
let writing: Uint8Array[] = []
let readOffset = 0
const encoder = new TextEncoder(), decoder = new TextDecoder()
const locate = (location: { handle: string; path: string }) => `${grants.get(location.handle)}/${location.path}`.replace(/\/$/, '')
const credentials = { state: vi.fn<PluginCredentialApi['state']>(async () => 'ok'), handle: vi.fn<PluginCredentialApi['handle']>(async () => 'opaque-handle'), set: vi.fn<PluginCredentialApi['set']>(), delete: vi.fn<PluginCredentialApi['delete']>() }
const rpc = { handleOperation: vi.fn<PluginBackendApi['rpc']['handleOperation']>(() => () => {}), handle: vi.fn<PluginBackendApi['rpc']['handle']>(() => () => {}), emit: vi.fn() }
const api: { process: Pick<PluginBackendApi['process'], 'shutdown'>; settings: Pick<PluginBackendApi['settings'], 'get'>; data: PluginBackendApi['data']; ai: Pick<PluginBackendApi['ai'], 'onStream' | 'cancel' | 'connections' | 'models'>; policy: Pick<PluginBackendApi['policy'], 'read' | 'checkFile'>; rpc: typeof rpc; storage: Pick<PluginBackendApi['storage'], 'open'|'close'|'stat'|'readBytes'|'write'|'writeBytes'|'mkdir'|'move'|'remove'|'list'>; credentials: typeof credentials; sealed: Pick<PluginBackendApi['sealed'], 'openRead'|'readChunk'|'beginWrite'|'writeChunk'|'commitWrite'|'close'> } = {
  process: { shutdown: async () => {} }, settings: { get: () => ({}) }, data: datasetFixture(), ai: { onStream: () => () => {}, cancel: async () => true, connections: async () => [], models: async () => [] },
  policy: { checkFile: async () => {}, read: async () => ({ defaultWrite: { decision: 'confirm' }, tools: {}, commands: {}, files: { visitMode: 'allow-all-except-blocked', defaultRead: { decision: 'allow' }, defaultWrite: { decision: 'confirm' }, allowedToVisit: ['**'], allowedToWrite: [], blocked: [], readOverrides: {}, writeOverrides: {} }, dangerousMode: { enabled: false, scope: 'off' }, pluginPresets: {} }) },
  rpc,
  storage: {
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
beforeEach(() => { files.clear(); grants.clear(); ledger = null; api.data = datasetFixture(); vi.clearAllMocks(); initBackend(api as unknown as PluginBackendApi) })
afterEach(async () => { await releaseFileAccess() })
describe('Assistant package persistence', () => {
  it('resolves external and home paths in ordinary Chat only with Full access', async () => {
    await saveChat('/vault', { id: 'native-chat', title: 'Code', createdAt: 1, updatedAt: 1, messages: [{ role: 'user', content: 'Create a fern study.' }] })
    const root = { id: crypto.randomUUID(), projectId: 'access-full', path: '/', name: 'full' }
    const access = vi.fn(async () => ({ mode: 'full' as const, root, cwd: '/fixture/home', home: '/fixture/home' }))
    const context = await executionContext('native-chat', { projects: { access } } as unknown as Pick<PluginBackendApi, 'projects'>)
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
    const original = api.storage.write
    const write = vi.spyOn(api.storage, 'write').mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { finish = resolve }); return original(...args) })
    const close = vi.spyOn(api.storage, 'close')
    try {
      const save = rpc.handle.mock.calls.find(([method]) => method === 'ai.writeRule')![1]
      const saving = save({ name: 'forest', content: 'Preserve the wetlands' })
      await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
      let disposed = false
      const draining = dispose().then(() => { disposed = true })
      await expect(save({ name: 'late', content: 'not accepted' })).rejects.toThrow('closing')
      await Promise.resolve(); expect(disposed).toBe(false); expect(close).not.toHaveBeenCalled()
      finish(); await saving; await draining
      expect([...files.values()].some(value => decoder.decode(value) === 'Preserve the wetlands')).toBe(true)
      expect(close).toHaveBeenCalled()
    } finally { finish?.(); await dispose(); write.mockRestore(); close.mockRestore() }
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
    expect(await getCredential('/vault', key, [endpoint])).toBe('opaque-handle')
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

})


it('hides empty histories without deleting records and keeps queued or attachment-only chats', async () => {
  const { listChats, rebuildChatSearch } = await import('../src/backend/threads')
  const empty = { id: 'empty-draft', title: 'New chat', createdAt: 1, updatedAt: 1, messages: [] }
  await saveChat('/vault', empty)
  await saveChat('/vault', { ...empty, id: 'queued-draft', pendingMessages: [{ id: 'queued', text: 'Describe moss' }] })
  await saveChat('/vault', { ...empty, id: 'attachment-chat', messages: [{ role: 'user', content: '', attachmentFiles: [{ fileName: 'fern.png', path: 'fern.png', kind: 'image' }] }] })
  await rebuildChatSearch('/vault')
  expect((await listChats('/vault')).map(chat => chat.id)).toEqual(expect.arrayContaining(['queued-draft', 'attachment-chat']))
  expect((await listChats('/vault')).some(chat => chat.id === empty.id)).toBe(false)
  expect(await readChat('/vault', empty.id)).toMatchObject(empty)
})
