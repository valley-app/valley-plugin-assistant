import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalDraft } from '@valley/plugin-sdk'
import { createApprovalOwner, APPROVAL_LIMITS, IN_APP_APPROVAL_TTL } from '../src/approvalOwner'
import { initLocalization } from '../src/localization'
import { createMockValleyApi } from './mock'
import en from '../locales/en.json'
import de from '../locales/de.json'
import es from '../locales/es.json'
import fr from '../locales/fr.json'
import zhCN from '../locales/zh-CN.json'

const owners: ReturnType<typeof createApprovalOwner>[] = []
const draft = (): ApprovalDraft => ({ caller: 'agent', target: { kind: 'tool', id: 'write_note', sideEffect: 'write' }, actionLabel: 'Write note', argsPreview: { path: 'Fern.md' }, canRememberApproval: true })
const origin = (chatRef = 'forest') => ({ channelId: 'telegram', chatRef })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function turns() { for (let i = 0; i < 24; i++) await Promise.resolve() }
function fixture() {
  const mock = createMockValleyApi()
  const ports = { active: () => true, notify: vi.fn(), error: vi.fn(), remember: vi.fn(async () => ({ ok: true })), audit: vi.fn() }
  const owner = createApprovalOwner(mock.api, ports)
  owners.push(owner)
  return { ...mock, owner, ports }
}
afterEach(async () => { await Promise.allSettled(owners.splice(0).map(owner => owner.dispose())); vi.useRealTimers(); vi.restoreAllMocks() })

describe('Assistant approval ownership', () => {
  it('binds remote choices to their exact channel and chat before remembering or resolving', async () => {
    const f = fixture()
    const first = f.owner.request(draft(), origin(), 'forest')
    const second = f.owner.request(draft(), origin('wetland'), 'wetland')
    await turns()
    const id = [...f.pendingApprovals.values()].find(record => record.chatId === 'forest')!.requestId
    expect(f.owner.channelChoice(id, 'aallow', origin('wetland'))).toBe(false)
    expect(f.owner.channelChoice(id, 'aallow', { ...origin(), channelId: 'other' })).toBe(false)
    f.owner.respond(id, 'always-allow')
    expect(f.ports.remember).not.toHaveBeenCalled()
    expect(f.owner.channelReply(origin('wetland'), true)).toBe(true)
    await expect(second).resolves.toBe(true)
    expect(f.pendingApprovals.has(id)).toBe(true)
    expect(f.owner.channelChoice(id, 'aallow', origin())).toBe(true)
    await expect(first).resolves.toBe(true)
    expect(f.ports.remember).toHaveBeenCalledOnce()
    expect(f.owner.channelChoice(id, 'aallow', origin())).toBe(false)
  })

  it('rejects an expired remember choice even when its timer has not run', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const waiting = f.owner.request(draft(), 'ui', 'forest')
    const card = f.owner.activeRequest('forest')!
    vi.setSystemTime(card.expiresAt)
    f.owner.respond(card.requestId, 'always-allow')
    await expect(waiting).resolves.toBe(false)
    expect(f.ports.remember).not.toHaveBeenCalled()
    expect(f.ports.audit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'expired' }))
    expect(f.owner.activeRequest('forest')).toBeNull()
  })

  it('captures the approval target and denies remembered allowance when policy disallows it', async () => {
    const f = fixture(), original = draft()
    const waiting = f.owner.request(original, 'ui', 'forest')
    const card = f.owner.activeRequest('forest')!
    original.target.id = 'delete_all'
    ;(original.argsPreview as { path: string }).path = 'Changed.md'
    card.target.id = 'delete_all'
    ;(card.argsPreview as { path: string }).path = 'Changed.md'
    f.owner.respond(card.requestId, 'always-allow')
    await expect(waiting).resolves.toBe(true)
    expect(f.ports.remember).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ id: 'write_note' }), argsPreview: { path: 'Fern.md' } }), 'allow')
    const denied = f.owner.request({ ...draft(), canRememberApproval: false }, 'ui', 'forest')
    f.owner.respond(f.owner.activeRequest('forest')!.requestId, 'always-allow')
    await expect(denied).resolves.toBe(false)
    expect(f.ports.remember).toHaveBeenCalledOnce()
  })

  it('keeps durable add before remove and joins both after cancellation without resurrecting the record', async () => {
    const f = fixture(), add = deferred<void>(), remove = deferred<void>()
    const save = f.api.assistant.addPending, clear = f.api.assistant.removePending
    vi.spyOn(f.api.assistant, 'addPending').mockImplementation(async record => { await add.promise; return save(record) })
    const removing = vi.spyOn(f.api.assistant, 'removePending').mockImplementation(async id => { await remove.promise; return clear(id) })
    const run = { awaitingApproval: false, cancelled: false, controller: new AbortController() }
    const waiting = f.owner.request(draft(), origin(), 'forest', run)
    run.controller.abort()
    let done = false
    const draining = f.owner.dispose().then(() => { done = true })
    expect(f.owner.dispose()).toBe(f.owner.dispose())
    await turns()
    expect(removing).not.toHaveBeenCalled()
    expect(done).toBe(false)
    add.resolve()
    await turns()
    expect(removing).toHaveBeenCalledOnce()
    expect(f.pendingApprovals.size).toBe(1)
    expect(done).toBe(false)
    remove.resolve()
    await expect(waiting).resolves.toBe(false)
    await draining
    expect(f.pendingApprovals.size).toBe(0)
    expect(f.driverCalls.some(call => call.method === 'sendButtons')).toBe(false)
    expect(run.awaitingApproval).toBe(false)
  })

  it('retains failed removal ownership and rejects replacement until cleanup succeeds', async () => {
    const f = fixture()
    const waiting = f.owner.request(draft(), origin(), 'forest')
    await turns()
    const clear = f.api.assistant.removePending
    vi.spyOn(f.api.assistant, 'removePending').mockResolvedValue({ ok: false, error: 'Save failed' })
    const rejected = expect(waiting).rejects.toThrow(en['assistant.guard.persistenceFailed'])
    f.owner.channelReply(origin(), true)
    await rejected
    await expect(f.owner.request(draft(), origin(), 'forest')).rejects.toThrow(en['assistant.guard.chatPending'])
    await expect(f.owner.drain()).rejects.toThrow(en['assistant.guard.persistenceFailed'])
    expect(f.pendingApprovals.size).toBe(1)
    vi.mocked(f.api.assistant.removePending).mockImplementation(clear)
    await f.owner.drain()
    const next = f.owner.request(draft(), origin(), 'forest')
    await turns()
    f.owner.channelReply(origin(), false)
    await expect(next).resolves.toBe(false)
    expect(f.pendingApprovals.size).toBe(0)
  })

  it('counts retained request bytes through failed cleanup and releases them after acknowledged removal', async () => {
    const f = fixture()
    const large = { ...draft(), argsPreview: { text: 'x'.repeat(APPROVAL_LIMITS.requestBytes - 2048) } }
    const waiting = Array.from({ length: 16 }, (_, index) => f.owner.request(large, origin(`chat-${index}`), `chat-${index}`))
    await turns()
    await expect(f.owner.request(large, 'ui', 'overflow')).rejects.toThrow(en['assistant.guard.requestTooLarge'])
    const clear = f.api.assistant.removePending
    vi.spyOn(f.api.assistant, 'removePending').mockResolvedValue({ ok: false, error: 'Disk unavailable' })
    const rejected = Promise.allSettled(waiting)
    f.owner.pause()
    expect((await rejected).every(result => result.status === 'rejected')).toBe(true)
    f.owner.resume()
    await expect(f.owner.request(large, 'ui', 'still-full')).rejects.toThrow(en['assistant.guard.requestTooLarge'])
    vi.mocked(f.api.assistant.removePending).mockImplementation(clear)
    await f.owner.drain()
    const fresh = f.owner.request(large, 'ui', 'fresh')
    f.owner.respond(f.owner.activeRequest('fresh')!.requestId, 'skip')
    await expect(fresh).resolves.toBe(false)
  })

  it('joins an accepted remembered choice on cancellation without authorizing the action or admitting its replacement early', async () => {
    const f = fixture(), saved = deferred<{ ok: true }>()
    f.ports.remember.mockImplementation(() => saved.promise)
    const waiting = f.owner.request(draft(), origin(), 'forest')
    await turns()
    const id = [...f.pendingApprovals.keys()][0]
    f.owner.channelChoice(id, 'aallow', origin())
    await turns()
    expect(f.ports.remember).toHaveBeenCalledOnce()
    await expect(f.owner.request(draft(), origin(), 'forest')).rejects.toThrow(en['assistant.guard.chatPending'])
    let drained = false
    const disposal = f.owner.dispose().then(() => { drained = true })
    await turns()
    expect(drained).toBe(false)
    saved.resolve({ ok: true })
    await disposal
    await expect(waiting).resolves.toBe(false)
    expect(f.ports.remember).toHaveBeenCalledOnce()
  })

  it('clears a possibly accepted failed add before reporting failure and never sends its buttons', async () => {
    const f = fixture(), save = f.api.assistant.addPending
    vi.spyOn(f.api.assistant, 'addPending').mockImplementation(async record => {
      await save(record)
      throw new Error('Add acknowledgement lost')
    })
    await expect(f.owner.request(draft(), origin(), 'forest')).rejects.toThrow('Add acknowledgement lost')
    expect(f.pendingApprovals.size).toBe(0)
    expect(f.driverCalls.some(call => call.method === 'sendButtons')).toBe(false)
    expect(f.api.assistant.addPending).toHaveBeenCalledOnce()
  })

  it('captures the channel destination and translator before another session is initialized', async () => {
    const f = fixture(), destination = origin(), add = deferred<void>(), save = f.api.assistant.addPending
    f.api.ui.t = key => de[key as keyof typeof de] ?? key
    vi.spyOn(f.api.assistant, 'addPending').mockImplementation(async record => { await add.promise; return save(record) })
    const waiting = f.owner.request(draft(), destination, 'forest')
    destination.chatRef = 'other'
    const next = createMockValleyApi()
    next.api.ui.t = key => fr[key as keyof typeof fr] ?? key
    initLocalization(next.api)
    add.resolve()
    await turns()
    const sent = f.driverCalls.find(call => call.method === 'sendButtons')!.payload
    expect(sent).toMatchObject({ chatRef: 'forest', buttons: expect.arrayContaining([expect.objectContaining({ label: `✅ ${de['auto.c551e6cf17a5']}` })]) })
    expect(f.owner.channelReply(origin('other'), true)).toBe(false)
    f.owner.channelReply(origin(), false)
    await expect(waiting).resolves.toBe(false)
  })

  it('keeps tokens one-use, exactly bound, expiring, and revoked by run/session cancellation', async () => {
    vi.useFakeTimers()
    const f = fixture(), run = new AbortController()
    const token = f.owner.mintToken('preview-a', run.signal)
    expect(f.owner.consumeToken(token, 'preview-b')).toBe(false)
    expect(f.owner.consumeToken(token)).toBe(false)
    expect(f.owner.consumeToken(token, 'preview-a')).toBe(true)
    expect(f.owner.consumeToken(token, 'preview-a')).toBe(false)
    const cancelled = f.owner.mintToken('preview-a', run.signal)
    run.abort()
    expect(f.owner.consumeToken(cancelled, 'preview-a')).toBe(false)
    const expired = f.owner.mintToken('preview-a')
    vi.setSystemTime(Date.now() + IN_APP_APPROVAL_TTL)
    expect(f.owner.consumeToken(expired, 'preview-a')).toBe(false)
    const paused = f.owner.mintToken('preview-a')
    f.owner.pause()
    expect(f.owner.consumeToken(paused, 'preview-a')).toBe(false)
    expect(() => f.owner.mintToken()).toThrow(en['assistant.guard.inactive'])
    f.owner.resume()
    const ended = f.owner.mintToken('preview-a')
    await f.owner.dispose()
    expect(f.owner.consumeToken(ended, 'preview-a')).toBe(false)
  })

  it('caps retained tokens and releases capacity only through consumption or expiry', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const tokens = Array.from({ length: APPROVAL_LIMITS.tokens }, () => f.owner.mintToken('bound'))
    expect(() => f.owner.mintToken()).toThrow(en['assistant.guard.queueFull'])
    expect(f.owner.consumeToken(tokens[0], 'wrong')).toBe(false)
    expect(() => f.owner.mintToken()).toThrow(en['assistant.guard.queueFull'])
    expect(f.owner.consumeToken(tokens[0], 'bound')).toBe(true)
    expect(f.owner.mintToken()).toBeTruthy()
    await vi.advanceTimersByTimeAsync(IN_APP_APPROVAL_TTL)
    expect(f.owner.mintToken()).toBeTruthy()
  })

  it.each([en, de, es, fr, zhCN])('reports localized admission rejection without dropping existing cards', async catalog => {
    const f = fixture()
    f.api.ui.t = key => catalog[key as keyof typeof catalog] ?? key
    const waiting = Array.from({ length: APPROVAL_LIMITS.pending }, (_, i) => f.owner.request(draft(), 'ui', `chat-${i}`))
    await expect(f.owner.request(draft(), 'ui', 'overflow')).rejects.toThrow(catalog['assistant.guard.queueFull'])
    expect(f.owner.activeRequest('chat-0')).not.toBeNull()
    f.owner.pause()
    expect(await Promise.all(waiting)).toEqual(Array.from({ length: APPROVAL_LIMITS.pending }, () => false))
    f.owner.resume()
    const fresh = f.owner.request(draft(), 'ui', 'fresh')
    f.owner.respond(f.owner.activeRequest('fresh')!.requestId, 'skip')
    await fresh
  })

  it('bounds input bytes and retains native-dialog capacity until its late answer settles', async () => {
    vi.useFakeTimers()
    const f = fixture(), chosen = deferred<string>()
    await expect(f.owner.command({ ...draft(), argsPreview: { text: 'x'.repeat(APPROVAL_LIMITS.requestBytes) } })).rejects.toThrow(en['assistant.guard.requestTooLarge'])
    vi.mocked(f.api.ui.confirm).mockReturnValue(chosen.promise)
    const waiting = Array.from({ length: APPROVAL_LIMITS.pending }, () => f.owner.command(draft()))
    await turns()
    await vi.advanceTimersByTimeAsync(IN_APP_APPROVAL_TTL)
    expect((await Promise.all(waiting)).every(value => value === false)).toBe(true)
    await expect(f.owner.command(draft())).rejects.toThrow(en['assistant.guard.queueFull'])
    chosen.resolve('allow-once')
    await turns()
    await expect(f.owner.command(draft())).resolves.toBe(true)
  })

  it('revokes old requests and tokens across a vault A-to-B-to-A transition', async () => {
    const f = fixture(), start = f.api.getState().vault
    const waiting = f.owner.request(draft(), 'ui', 'forest')
    const id = f.owner.activeRequest('forest')!.requestId, token = f.owner.mintToken('bound')
    f.emitState({ vault: { path: '/fixtures/other', name: 'other', displayName: 'Other' } })
    f.emitState({ vault: start })
    f.owner.resume()
    f.owner.respond(id, 'always-allow')
    await expect(waiting).resolves.toBe(false)
    expect(f.owner.consumeToken(token, 'bound')).toBe(false)
    expect(f.ports.remember).not.toHaveBeenCalled()
    await expect(f.owner.request(draft(), 'ui', 'forest')).resolves.toBe(false)
  })
})
