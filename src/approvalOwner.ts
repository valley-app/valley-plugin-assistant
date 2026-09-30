import type { ApprovalDraft } from '@valley/plugin-sdk'
import type { GuardAuditEntry, GuardDecision, PendingApprovalRecord, PermissionRequest } from '@valley/plugin-sdk/guard/types'
import type { ValleyPluginApi } from './api'
import { approvalButtons, type ChannelApprovalAction } from './channelCommands'
import { createUiText } from './localization'

export const APPROVAL_LIMITS = { pending: 64, tokens: 128, requestBytes: 512 * 1024, totalBytes: 8 * 1024 * 1024 } as const
export const IN_APP_APPROVAL_TTL = 30 * 60 * 1000
export const CHANNEL_APPROVAL_TTL = 24 * 60 * 60 * 1000
export type ApprovalOrigin = 'ui' | { channelId: string; chatRef: string }
type Choice = 'allow-once' | 'skip' | 'always-allow' | 'always-ask' | 'block'
interface ApprovalRun { awaitingApproval: boolean; cancelled: boolean; controller: AbortController }
interface Entry {
  request: PermissionRequest
  origin: ApprovalOrigin
  bytes: number
  run?: ApprovalRun
  dialog: boolean
  live: boolean
  settled: boolean
  resolve(value: boolean): void
  reject(error: unknown): void
  timer: ReturnType<typeof setTimeout>
  offCancel(): void
  saved?: Promise<void>
}

const channelKey = (origin: Exclude<ApprovalOrigin, 'ui'>): string => JSON.stringify([origin.channelId, origin.chatRef])
const requestId = (): string => `r${crypto.randomUUID().replaceAll('-', '')}`

export function createApprovalOwner(api: ValleyPluginApi, ports: {
  active(): boolean
  notify(): void
  error(error: unknown): void
  remember(request: PermissionRequest, decision: GuardDecision): Promise<{ ok: boolean; error?: string }>
  audit(entry: GuardAuditEntry): void
}) {
  const text = createUiText(api)
  const root = api.getState().vault?.path ?? null
  const pending = new Map<string, Entry>()
  const allocations = new Set<Entry>()
  const channelPending = new Map<string, string>()
  const cleanup = new Map<string, { key: string; entry?: Entry; error?: unknown }>()
  const work = new Set<Promise<unknown>>()
  const tokens = new Map<string, { binding?: string; bytes: number; expiresAt: number; timer: ReturnType<typeof setTimeout>; off(): void }>()
  let bytes = 0
  let paused = false
  let closed = false
  let disposal: Promise<void> | undefined
  const active = (): boolean => {
    if (closed || paused || !ports.active()) return false
    try { return (api.getState().vault?.path ?? null) === root } catch { return false }
  }
  const tracked = <T,>(task: Promise<T>): Promise<T> => {
    work.add(task)
    void task.then(() => work.delete(task), () => work.delete(task))
    return task
  }
  const release = (entry: Entry): void => {
    if (allocations.delete(entry)) bytes -= entry.bytes
  }
  const valid = (entry: Entry): boolean => active() && Date.now() < entry.request.expiresAt && !entry.run?.cancelled && !entry.run?.controller.signal.aborted
  const removeToken = (token: string): void => {
    const entry = tokens.get(token)
    if (!entry) return
    tokens.delete(token)
    bytes -= entry.bytes
    clearTimeout(entry.timer)
    entry.off()
  }
  const removeRecord = async (id: string): Promise<void> => {
    const result = await api.assistant.removePending(id)
    if (!result.ok) throw new Error(result.error || text('assistant.guard.persistenceFailed'))
    const entry = cleanup.get(id)?.entry
    cleanup.delete(id)
    if (entry?.settled) release(entry)
  }
  const finish = (entry: Entry, approved: boolean, remember?: GuardDecision, expired = false, error?: unknown): void => {
    if (!entry.live) return
    entry.live = false
    pending.delete(entry.request.requestId)
    clearTimeout(entry.timer)
    entry.offCancel()
    if (entry.origin !== 'ui' && channelPending.get(channelKey(entry.origin)) === entry.request.requestId) channelPending.delete(channelKey(entry.origin))
    if (entry.run) entry.run.awaitingApproval = false
    if (expired) ports.audit({ ts: Date.now(), caller: entry.request.caller, decision: 'expired', source: 'global-guard', reason: 'Approval expired',
      targetKind: entry.request.target.kind, targetId: entry.request.target.id, path: entry.request.target.path,
      fileOperation: entry.request.target.fileOperation, channelId: entry.request.channelId, chatId: entry.request.chatId })
    if (entry.origin !== 'ui') cleanup.set(entry.request.requestId, { key: channelKey(entry.origin), entry })
    const settling = (async () => {
      try {
        if (entry.saved) {
          try { await entry.saved } catch (failure) { error ??= failure }
          try { await removeRecord(entry.request.requestId) }
          catch (failure) {
            const retained = cleanup.get(entry.request.requestId)
            if (retained) retained.error = failure
            throw new Error(text('assistant.guard.persistenceFailed'))
          }
        }
        if (error) throw error
        const allowed = valid(entry)
        if (remember && allowed) {
          const saved = await ports.remember(entry.request, remember)
          if (!saved.ok) throw new Error(saved.error || text('assistant.guard.persistenceFailed'))
        }
        entry.resolve(approved && allowed && valid(entry))
      } catch (failure) { ports.error(failure); entry.reject(failure) }
      finally {
        entry.settled = true
        if (!entry.dialog && !cleanup.has(entry.request.requestId)) release(entry)
      }
    })()
    tracked(settling)
    ports.notify()
  }
  const current = (id: string): Entry | undefined => {
    const entry = pending.get(id)
    if (entry && !valid(entry)) { finish(entry, false, undefined, Date.now() >= entry.request.expiresAt); return }
    return entry
  }
  const admit = (draft: ApprovalDraft, origin: ApprovalOrigin, chatId: string, dialog: boolean, run?: ApprovalRun) => {
    if (!active() || run?.cancelled || run?.controller.signal.aborted) return
    if (allocations.size + [...cleanup.values()].filter(item => !item.entry).length >= APPROVAL_LIMITS.pending) throw new Error(text('assistant.guard.queueFull'))
    const key = origin === 'ui' ? null : channelKey(origin)
    if (key !== null && ([...allocations].some(entry => entry.origin !== 'ui' && channelKey(entry.origin) === key) || [...cleanup.values()].some(item => item.key === key))) {
      throw new Error(text('assistant.guard.chatPending'))
    }
    let copy: ApprovalDraft, size: number
    try {
      const encoded = JSON.stringify({ draft, origin, chatId })
      size = new TextEncoder().encode(encoded).length
      const captured = JSON.parse(encoded) as { draft: ApprovalDraft; origin: ApprovalOrigin }
      copy = captured.draft
      origin = captured.origin
    } catch { throw new Error(text('assistant.guard.requestTooLarge')) }
    if (size > APPROVAL_LIMITS.requestBytes || size > APPROVAL_LIMITS.totalBytes - bytes) throw new Error(text('assistant.guard.requestTooLarge'))
    const now = Date.now(), id = requestId()
    const request: PermissionRequest = { requestId: id, createdAt: now, expiresAt: now + (origin === 'ui' ? IN_APP_APPROVAL_TTL : CHANNEL_APPROVAL_TTL),
      caller: origin === 'ui' ? 'agent' : 'channel', channelId: origin === 'ui' ? undefined : origin.channelId,
      chatId, actionLabel: copy.actionLabel, target: copy.target, argsPreview: copy.argsPreview, diffPreview: copy.diffPreview, canRememberApproval: copy.canRememberApproval }
    let entry!: Entry
    const result = new Promise<boolean>((resolve, reject) => {
      const cancel = (): void => finish(entry, false)
      entry = { request, origin, bytes: size, run, dialog, live: true, settled: false, resolve, reject,
        timer: setTimeout(() => finish(entry, false, undefined, true), request.expiresAt - now),
        offCancel: () => run?.controller.signal.removeEventListener('abort', cancel) }
      run?.controller.signal.addEventListener('abort', cancel, { once: true })
    })
    pending.set(id, entry)
    allocations.add(entry)
    bytes += size
    if (run) run.awaitingApproval = true
    if (origin !== 'ui') channelPending.set(channelKey(origin), id)
    return { entry, result }
  }
  const settleChoice = (entry: Entry, approved: boolean, remember?: GuardDecision): void => {
    if (remember === 'allow' && !entry.request.canRememberApproval) { finish(entry, false); return }
    finish(entry, approved, remember)
  }
  const pause = (): void => {
    paused = true
    for (const token of [...tokens.keys()]) removeToken(token)
    for (const entry of [...pending.values()]) finish(entry, false)
  }
  const drain = async (): Promise<void> => {
    while (work.size) await Promise.allSettled([...work])
    for (const [id, value] of [...cleanup]) {
      try { await tracked(removeRecord(id)) } catch (error) { value.error = error; throw new Error(text('assistant.guard.persistenceFailed')) }
    }
  }
  const offState = api.subscribe(() => {
    try { if ((api.getState().vault?.path ?? null) === root) return } catch {}
    closed = true
    pause()
  })

  return {
    active,
    inactiveReason: () => text('assistant.guard.inactive'),
    activeRequest(chatId: string): PermissionRequest | null {
      for (const entry of pending.values()) if (!entry.dialog && entry.request.caller === 'agent' && entry.request.chatId === chatId) return JSON.parse(JSON.stringify(entry.request)) as PermissionRequest
      return null
    },
    request(draft: ApprovalDraft, origin: ApprovalOrigin, chatId: string, run?: ApprovalRun): Promise<boolean> {
      let admitted: ReturnType<typeof admit>
      try { admitted = admit(draft, origin, chatId, false, run) } catch (error) { return Promise.reject(error) }
      if (!admitted) return Promise.resolve(false)
      const { entry, result } = admitted
      if (entry.origin !== 'ui') {
        const captured = entry.origin
        const record: PendingApprovalRecord = { requestId: entry.request.requestId, channelId: captured.channelId, chatRef: captured.chatRef,
          chatId, actionLabel: entry.request.actionLabel, createdAt: entry.request.createdAt, expiresAt: entry.request.expiresAt }
        entry.saved = tracked((async () => {
          const saved = await api.assistant.addPending(record)
          if (!saved.ok) throw new Error(saved.error || text('assistant.guard.persistenceFailed'))
        })())
        tracked(entry.saved.then(async () => {
          if (!entry.live || !valid(entry)) return
          const summary = JSON.stringify(entry.request.argsPreview)?.slice(0, 160) ?? ''
          const sent = await api.channels.sendButtons(captured.channelId, captured.chatRef, `Confirm action "${entry.request.actionLabel}" ${summary}?`, approvalButtons(entry.request.requestId, entry.request.canRememberApproval, text))
          if (!sent.ok) throw new Error(sent.error || text('assistant.guard.promptFailed'))
        }).catch(error => { if (entry.live) finish(entry, false, undefined, false, error) }))
      }
      ports.notify()
      return result
    },
    command(draft: ApprovalDraft): Promise<boolean> {
      let admitted: ReturnType<typeof admit>
      try { admitted = admit(draft, 'ui', '', true) } catch (error) { return Promise.reject(error) }
      if (!admitted) return Promise.resolve(false)
      const { entry, result } = admitted
      void Promise.resolve().then(() => {
        if (!entry.live || !valid(entry)) return null
        const { createElement } = api.React
        return api.ui.confirm({ title: text('assistant.guard.confirmTitle'), message: createElement('div', null,
          createElement('p', null, text('assistant.guard.confirmMessage', { action: entry.request.actionLabel })),
          createElement('pre', null, JSON.stringify(entry.request.argsPreview, null, 2)), entry.request.diffPreview ? createElement('pre', null, entry.request.diffPreview) : null),
        actions: [{ label: text('auto.77dfd2135f4d'), value: 'cancel', variant: 'ghost' }, { label: text('auto.c551e6cf17a5'), value: 'allow-once', variant: 'primary' }] })
      }).then(choice => finish(entry, choice === 'allow-once'), () => finish(entry, false)).finally(() => release(entry))
      return result
    },
    respond(id: string, action: Choice): void {
      const entry = current(id)
      if (!entry || entry.dialog || entry.origin !== 'ui') return
      settleChoice(entry, action !== 'skip' && action !== 'block', action === 'always-allow' ? 'allow' : action === 'always-ask' ? 'confirm' : action === 'block' ? 'deny' : undefined)
    },
    channelChoice(id: string, action: ChannelApprovalAction, origin: Exclude<ApprovalOrigin, 'ui'>): boolean {
      const entry = current(id)
      if (!entry || entry.origin === 'ui' || channelKey(entry.origin) !== channelKey(origin)) return false
      settleChoice(entry, action === 'allow' || action === 'aallow', action === 'aallow' ? 'allow' : action === 'aask' ? 'confirm' : action === 'block' ? 'deny' : undefined)
      return true
    },
    channelReply(origin: Exclude<ApprovalOrigin, 'ui'>, approved: boolean): boolean {
      const id = channelPending.get(channelKey(origin))
      const entry = id ? current(id) : undefined
      if (!entry) return false
      finish(entry, approved)
      return true
    },
    cancelChat(chatId: string): void { for (const entry of [...pending.values()]) if (entry.request.chatId === chatId) finish(entry, false) },
    mintToken(binding?: string, signal?: AbortSignal): string {
      if (!active() || signal?.aborted) throw new Error(text('assistant.guard.inactive'))
      for (const [token, entry] of tokens) if (entry.expiresAt <= Date.now()) removeToken(token)
      if (tokens.size >= APPROVAL_LIMITS.tokens) throw new Error(text('assistant.guard.queueFull'))
      const size = binding === undefined ? 0 : new TextEncoder().encode(binding).length
      if (size > 4096 || size > APPROVAL_LIMITS.totalBytes - bytes) throw new Error(text('assistant.guard.requestTooLarge'))
      const token = requestId(), remove = (): void => removeToken(token)
      tokens.set(token, { binding, bytes: size, expiresAt: Date.now() + IN_APP_APPROVAL_TTL, timer: setTimeout(remove, IN_APP_APPROVAL_TTL), off: () => signal?.removeEventListener('abort', remove) })
      bytes += size
      signal?.addEventListener('abort', remove, { once: true })
      return token
    },
    consumeToken(token: string, binding?: string): boolean {
      const entry = tokens.get(token)
      if (!entry) return false
      if (!active() || entry.expiresAt <= Date.now()) { removeToken(token); return false }
      if (entry.binding !== binding) return false
      removeToken(token)
      return true
    },
    async recover(): Promise<void> {
      const listed = await tracked(api.assistant.listPending())
      if (!listed.ok) throw new Error(listed.error || text('assistant.guard.persistenceFailed'))
      for (const record of listed.data?.pending ?? []) {
        cleanup.set(record.requestId, { key: channelKey({ channelId: record.channelId ?? '', chatRef: record.chatRef ?? '' }) })
        ports.audit({ ts: Date.now(), caller: 'channel', decision: 'expired', source: 'global-guard', reason: 'Pending approval recovered after restart', targetKind: 'tool', channelId: record.channelId, chatId: record.chatId })
        try { await tracked(removeRecord(record.requestId)) }
        catch (error) {
          const retained = cleanup.get(record.requestId)
          if (retained) retained.error = error
          paused = true
          throw new Error(text('assistant.guard.persistenceFailed'))
        }
      }
    },
    pause,
    resume: () => { if (!closed) paused = false },
    drain,
    dispose(): Promise<void> {
      if (disposal) return disposal
      closed = true
      offState()
      pause()
      return disposal = drain()
    }
  }
}
