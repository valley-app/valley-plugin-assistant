import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalDraft } from '@valley/plugin-sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { initLocalization } from '../src/localization'
import en from '../locales/en.json'
import de from '../locales/de.json'
import es from '../locales/es.json'
import fr from '../locales/fr.json'
import zhCN from '../locales/zh-CN.json'
import { createMockValleyApi } from './mock'
import { getStore, disposeStore } from '../src/store'
import { SessionCoordinator } from '../src/backend/engine/coordinator'
import { AssistantRepository } from '../src/backend/persistence/repositories'
import { datasetFixture } from './backendDatasetFixture'
import type { TurnSubmission } from '../src/contracts/execution'

afterEach(() => { vi.useRealTimers() })
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
const until = async (predicate: () => boolean): Promise<void> => { await vi.waitFor(() => expect(predicate()).toBe(true)) }
const draft = (): ApprovalDraft => ({ caller: 'channel', target: { kind: 'tool', id: 'write_note', sideEffect: 'write' }, actionLabel: 'write_note', argsPreview: {}, canRememberApproval: false })
const turn = (conversationId: string): TurnSubmission => ({ id: crypto.randomUUID(), conversationId, text: 'Write note', thread: { id: conversationId, title: conversationId, createdAt: 1, updatedAt: 1, messages: [] } })

describe('backend pending approvals', () => {
  it('releases its slot while awaiting approval and reacquires capacity before effects resume', async () => {
    let approve!: () => void, finishOther!: () => void
    const effects: string[] = []
    const coordinator = new SessionCoordinator(new AssistantRepository(datasetFixture()), { publish: vi.fn(), project: async () => {}, run: async (session, _turn, controls) => {
      await controls.state('INFERRING')
      if (session.conversationId === 'waiting') {
        await controls.state('AWAITING_TOOLS')
        await controls.state('AWAITING_APPROVAL')
        await new Promise<void>(resolve => { approve = resolve })
        await controls.state('EXECUTING_TOOLS')
        effects.push('approved')
      } else { effects.push('other'); await new Promise<void>(resolve => { finishOther = resolve }) }
    } }, 1)
    try {
      await coordinator.enqueue(turn('waiting'))
      await until(() => Boolean(approve))
      await coordinator.enqueue(turn('other'))
      await until(() => Boolean(finishOther))
      approve(); await tick()
      expect(effects).toEqual(['other'])
      finishOther()
      await until(() => effects.includes('approved'))
    } finally { await coordinator.close() }
  })
  it('cancels a pending approval on shutdown and never dispatches a late effect', async () => {
    const execute = vi.fn()
    const coordinator = new SessionCoordinator(new AssistantRepository(datasetFixture()), { publish: vi.fn(), project: async () => {}, run: async (_session, _turn, controls) => {
      await controls.state('INFERRING'); await controls.state('AWAITING_TOOLS'); await controls.state('AWAITING_APPROVAL')
      await new Promise<void>(resolve => controls.signal.addEventListener('abort', () => resolve(), { once: true }))
      controls.signal.throwIfAborted()
      execute()
    } })
    await coordinator.enqueue(turn('waiting'))
    await until(() => coordinator.snapshot('waiting')?.state === 'AWAITING_APPROVAL')
    await coordinator.close()
    expect(execute).not.toHaveBeenCalled()
    expect(coordinator.snapshot('waiting')?.state).toBe('INTERRUPTED')
  })
  it('restores interrupted approval sessions without replaying the turn', async () => {
    const repository = new AssistantRepository(datasetFixture())
    const coordinator = new SessionCoordinator(repository, { publish: vi.fn(), project: async () => {}, run: async (_session, _turn, controls) => {
      await controls.state('INFERRING'); await controls.state('AWAITING_TOOLS'); await controls.state('AWAITING_APPROVAL')
      await new Promise<void>(resolve => controls.signal.addEventListener('abort', () => resolve(), { once: true }))
    } })
    await coordinator.enqueue(turn('waiting'))
    await until(() => coordinator.snapshot('waiting')?.state === 'AWAITING_APPROVAL')
    await coordinator.close()
    const run = vi.fn(async () => {})
    const restored = new SessionCoordinator(repository, { publish: vi.fn(), project: async () => {}, run })
    try {
      await restored.restore()
      expect(restored.snapshot('waiting')).toMatchObject({ state: 'INTERRUPTED', paused: true })
      expect(run).not.toHaveBeenCalled()
    } finally { await restored.close() }
  })
})

describe('assistant command-bus approvals', () => {
  afterEach(async () => { await disposeStore() })
  async function startWithoutConversation(mock: ReturnType<typeof createMockValleyApi>) {
    initLocalization(mock.api)
    const register = vi.spyOn(mock.api.guard, 'registerRuntime')
    const store = getStore(mock.api)
    vi.spyOn(store, 'newChat').mockImplementation(() => {})
    await store.whenReady
    expect(store.getSnapshot().active).toBeNull()
    return { store, bridge: register.mock.calls[0][0] }
  }

  it.each([
    ['en', en], ['de', de], ['es', es], ['fr', fr], ['zh-CN', zhCN]
  ] as const)('shows an independent confirmation in %s and allows only this invocation', async (_language, catalog) => {
    const mock = createMockValleyApi()
    mock.api.ui.t = (key, params) => (catalog[key as keyof typeof catalog] ?? key)
      .replace(/\{\{([^}]+)\}\}/g, (_match, name: string) => String(params?.[name] ?? ''))
    const { store, bridge } = await startWithoutConversation(mock)
    vi.mocked(mock.api.ui.confirm).mockResolvedValueOnce('allow-once').mockResolvedValueOnce(null)
    const request = { ...draft(), caller: 'plugin' as const, pluginId: 'renamed-browser', actionLabel: 'Open example.com', argsPreview: { url: 'https://example.com' }, diffPreview: 'One browser tab', canRememberApproval: true }

    await expect(bridge.requestApproval(request)).resolves.toBe(true)
    await expect(bridge.requestApproval(request)).resolves.toBe(false)

    expect(mock.api.ui.confirm).toHaveBeenCalledTimes(2)
    const options = vi.mocked(mock.api.ui.confirm).mock.calls[0][0]
    expect(options.title).toBe(catalog['assistant.guard.confirmTitle'])
    expect(options.actions).toEqual([
      { label: catalog['auto.77dfd2135f4d'], value: 'cancel', variant: 'ghost' },
      { label: catalog['auto.c551e6cf17a5'], value: 'allow-once', variant: 'primary' }
    ])
    const message = renderToStaticMarkup(mock.api.React.createElement('div', null, options.message))
    expect(message).toContain('Open example.com')
    expect(message).toContain('https://example.com')
    expect(message).toContain('One browser tab')
    expect(store.getSnapshot().pending).toBeNull()
    expect(mock.pendingApprovals.size).toBe(0)
    expect(mock.guardOverrides.size).toBe(0)
    expect(mock.driverCalls.some((call) => call.method === 'saveGuardOverrides')).toBe(false)
  })

  it.each(['cancel', null, 'unexpected'])('denies a %s response', async (choice) => {
    const mock = createMockValleyApi()
    const { bridge } = await startWithoutConversation(mock)
    vi.mocked(mock.api.ui.confirm).mockResolvedValue(choice)
    await expect(bridge.requestApproval(draft())).resolves.toBe(false)
  })

  it('denies when the shared confirmation fails', async () => {
    const mock = createMockValleyApi()
    const { bridge } = await startWithoutConversation(mock)
    vi.mocked(mock.api.ui.confirm).mockRejectedValue(new Error('Surface unavailable'))
    await expect(bridge.requestApproval(draft())).resolves.toBe(false)
  })

  it.each(['dispose', 'prepareUnload'] as const)('settles pending confirmations on %s and ignores late approval', async (transition) => {
    const mock = createMockValleyApi()
    const { store, bridge } = await startWithoutConversation(mock)
    let choose!: (value: string) => void
    vi.mocked(mock.api.ui.confirm).mockImplementation(() => new Promise((resolve) => { choose = resolve }))
    const approval = bridge.requestApproval(draft())
    await until(() => vi.mocked(mock.api.ui.confirm).mock.calls.length > 0)
    await store[transition]()
    await expect(approval).resolves.toBe(false)
    choose('allow-once')
    await expect(approval).resolves.toBe(false)
    await expect(bridge.requestApproval(draft())).resolves.toBe(false)
    expect(mock.api.ui.confirm).toHaveBeenCalledTimes(1)
  })
})
