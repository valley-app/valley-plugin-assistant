import * as React from 'react'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MainWorkspaceNavigation, MainWorkspaceViewProps, MarkdownViewProps, UiScrollPanelProps } from '@valley/plugin-sdk'
import { PLUGIN_SURFACE_V1, SEARCH_RESULT_ACTION_V1, WORKSPACE_DETAILS_V1 } from '@valley/plugin-sdk'
import { createMockValleyApi } from './mock'
import config from '../config.json'
import { register } from '../src/index'
import { getStore, type AssistantSnapshot } from '../src/store'
import { updateConversation } from '../src/commands'

let dispose: (() => void) | undefined
afterEach(() => { cleanup(); dispose?.(); dispose = undefined })

describe('declared Assistant view slots', () => {
  it('navigates chats and both channels entirely inside the right sidebar while retaining drafts', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    for (const [id, title, source] of [['canopy', 'Canopy survey', undefined], ['river', 'River observations', 'telegram'], ['meadow', 'Meadow observations', 'whatsapp']] as const) {
      mock.chatThreads.set(id, { id, title, source, createdAt: 1, updatedAt: 1, messages: [{ role: 'assistant', content: `${title} summary` }] })
    }
    dispose = register(mock.api)
    const store = getStore(mock.api)
    await store.whenReady
    await store.openChat('canopy')
    const openMain = vi.spyOn(mock.api.workspace, 'openMainTab')
    const Sidebar = new Map(vi.mocked(mock.api.registerView).mock.calls).get(config.uiSlots.right_sidebar) as React.ComponentType
    const view = render(<Sidebar />)
    const sources = () => within(view.getByRole('navigation', { name: 'Chat sources' }))
    fireEvent.change(view.getByRole('textbox', { name: 'Message Assistant' }), { target: { value: 'Compare canopy layers' } })
    fireEvent.click(view.getByRole('button', { name: 'Back to chats' }))
    fireEvent.change(view.getByRole('textbox', { name: 'Search chats' }), { target: { value: 'canopy' } })
    fireEvent.click(await view.findByRole('button', { name: 'Canopy survey' }))
    await waitFor(() => expect(view.getByRole('textbox', { name: 'Message Assistant' })).toHaveValue('Compare canopy layers'))
    fireEvent.click(view.getByRole('button', { name: 'Back to chats' }))
    expect(view.getByRole('textbox', { name: 'Search chats' })).toHaveValue('canopy')
    fireEvent.change(view.getByRole('textbox', { name: 'Search chats' }), { target: { value: '' } })
    for (const [label, id, title] of [['Telegram', 'river', 'River observations'], ['WhatsApp', 'meadow', 'Meadow observations']]) {
      fireEvent.click(sources().getByRole('button', { name: label }))
      fireEvent.click(await view.findByRole('button', { name: new RegExp(`^${title}`) }))
      await waitFor(() => expect(view.container.querySelector('.assistant-page-title')).toHaveTextContent(title))
      expect(store.getSnapshot().active?.id).toBe(id)
      expect(view.queryByRole('textbox', { name: 'Message Assistant' })).toBeNull()
      expect(view.container.querySelector('.assistant-channel-banner')).toHaveTextContent(label)
    }
    fireEvent.click(sources().getByRole('button', { name: 'Chat' }))
    fireEvent.click(view.getAllByRole('button', { name: 'New chat' })[0])
    await waitFor(() => expect(view.getByRole('textbox', { name: 'Message Assistant' })).toHaveValue(''))
    fireEvent.change(view.getByRole('textbox', { name: 'Message Assistant' }), { target: { value: 'A new forest question' } })
    fireEvent.click(view.getByRole('button', { name: 'Back to chats' }))
    fireEvent.click(view.getByRole('button', { name: 'Return to conversation' }))
    expect(view.getByRole('textbox', { name: 'Message Assistant' })).toHaveValue('A new forest question')
    fireEvent.click(sources().getByRole('button', { name: 'Chat' }))
    fireEvent.click(await view.findByRole('button', { name: 'Canopy survey' }))
    await waitFor(() => expect(view.getByRole('textbox', { name: 'Message Assistant' })).toHaveValue('Compare canopy layers'))
    fireEvent.click(view.getByRole('button', { name: 'Conversation settings' }))
    expect(await view.findByText('Access')).toBeVisible()
    expect(view.queryByRole('textbox', { name: 'Message Assistant' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Return to conversation' }))
    expect(view.getByRole('textbox', { name: 'Message Assistant' })).toHaveValue('Compare canopy layers')
    const send = vi.spyOn(store, 'send').mockResolvedValue(undefined)
    await act(async () => { fireEvent.keyDown(view.getByRole('textbox', { name: 'Message Assistant' }), { key: 'Enter' }) })
    expect(send).toHaveBeenCalledWith('Compare canopy layers', undefined)
    expect(openMain).not.toHaveBeenCalled()
  }, 15000)

  it('keeps sidebar voice local and removes disabled channel navigation', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' }, settings: { showTelegram: false, showWhatsApp: false } })
    dispose = register(mock.api)
    const store = getStore(mock.api)
    await store.whenReady
    const openMain = vi.spyOn(mock.api.workspace, 'openMainTab')
    const Sidebar = new Map(vi.mocked(mock.api.registerView).mock.calls).get(config.uiSlots.right_sidebar) as React.ComponentType
    const view = render(<Sidebar />)
    expect(view.queryByRole('button', { name: 'Telegram' })).toBeNull()
    expect(view.queryByRole('button', { name: 'WhatsApp' })).toBeNull()
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Start voice' })) })
    expect(store.getSnapshot().voiceConversationId).toBe(store.getSnapshot().active?.id)
    expect(openMain).not.toHaveBeenCalled()
  })

  it('creates a project chat and edits its draft properties without leaving the sidebar or saving an empty chat', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    const project = { id: 'forest', name: 'Forest survey', instructions: '', folders: [], createdAt: 1, updatedAt: 1 }
    const call = mock.api.backend.call
    mock.api.backend.call = (async (method, payload) => {
      if (method === 'projects.request' && (payload as { method?: string })?.method === 'list') return [project]
      if (method === 'activity.request') return { events: [], done: true, nextOffset: 0 }
      return call(method, payload)
    }) as typeof call
    dispose = register(mock.api)
    const store = getStore(mock.api)
    await store.whenReady
    const openMain = vi.spyOn(mock.api.workspace, 'openMainTab')
    const Sidebar = new Map(vi.mocked(mock.api.registerView).mock.calls).get(config.uiSlots.right_sidebar) as React.ComponentType
    const view = render(<Sidebar />)
    fireEvent.click(view.getByRole('button', { name: 'Back to chats' }))
    fireEvent.click(await view.findByRole('button', { name: 'Forest survey' }))
    fireEvent.click(view.getByRole('button', { name: 'New conversation: Forest survey' }))
    expect(store.getSnapshot().active?.projectId).toBe('forest')
    fireEvent.click(view.getByRole('button', { name: 'Conversation settings' }))
    const title = await view.findByRole('textbox', { name: 'Title' })
    fireEvent.change(title, { target: { value: 'New canopy survey' } })
    fireEvent.blur(title)
    await waitFor(() => expect(store.getSnapshot().active?.title).toBe('New canopy survey'))
    fireEvent.click(view.getByRole('switch', { name: 'Pinned' }))
    await waitFor(() => expect(store.getSnapshot().active?.pinned).toBe(true))
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Return to conversation' })) })
    expect(view.container.querySelector('.assistant-page-title')).toHaveTextContent('New canopy survey')
    expect(store.getSnapshot().active?.titleOrigin).toBe('manual')
    expect(mock.chatThreads.size).toBe(0)
    expect(view.queryByRole('alert')).toBeNull()
    expect(openMain).not.toHaveBeenCalled()
  }, 15000)

  it('exposes live footer details for the selected chat and unregisters the provider', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    mock.chatThreads.set('canopy', { id: 'canopy', title: 'Canopy survey', createdAt: 1, updatedAt: 1, model: { provider: 'forest', model: 'canopy-model' }, messages: [
      { role: 'user', content: 'Describe the canopy.' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'inspect', name: 'inspect', arguments: {} }] },
      { role: 'tool', content: 'Three layers', toolCallId: 'inspect' },
      { role: 'assistant', content: 'The canopy has three layers.' }
    ] })
    dispose = register(mock.api)
    const store = getStore(mock.api)
    await store.whenReady
    await store.openChat('canopy')
    const provider = mock.api.interop.extensions.providers(WORKSPACE_DETAILS_V1)[0].extension
    expect(config.provides).toContainEqual({ id: 'workspace.details', kind: 'extension', version: '1.0.0' })
    expect(provider.defaultItems).toEqual(['title', 'status'])
    expect(provider.items.map(item => item.id)).toEqual(['title', 'status', 'model', 'messages', 'queued', 'running', 'access', 'source'])
    const context = { selectedItemIds: provider.items.map(item => item.id) }
    expect(provider.getSnapshot(context).items).toMatchObject({ title: { text: 'Canopy survey' }, status: { text: 'Finished' }, model: { text: 'canopy-model' }, messages: { text: 'Messages: 2' }, queued: { text: 'Queued messages: 0' }, running: { text: 'Running chats: 0' } })
    const base = store.getSnapshot()
    const snapshot = vi.spyOn(store, 'getSnapshot')
    const cases: Array<[Partial<AssistantSnapshot>, string]> = [
      [{ activeBusy: true, sessionState: 'PREPARING' }, 'Preparing'],
      [{ activeBusy: true, sessionState: 'INFERRING' }, 'Thinking'],
      [{ activeBusy: true, sessionState: 'INFERRING', streamingText: 'The canopy' }, 'Writing'],
      [{ activeBusy: true, sessionState: 'EXECUTING_TOOLS', phase: 'working' }, 'Working'],
      [{ sessionState: 'AWAITING_APPROVAL' }, 'Waiting for approval'],
      [{ sessionState: 'AWAITING_QUESTION' }, 'Waiting for you'],
      [{ sessionState: 'QUEUED' }, 'Queued'],
      [{ sessionState: 'COMPACTING' }, 'Compacting context'],
      [{ stopped: true }, 'Stopped'],
      [{ error: 'Provider unavailable' }, 'Error'],
      [{ active: { ...base.active!, messages: [] } }, 'Ready']
    ]
    for (const [patch, label] of cases) {
      snapshot.mockReturnValue({ ...base, ...patch })
      expect(provider.getSnapshot(context).items.status.text).toBe(label)
    }
    snapshot.mockReturnValue({ ...base, runningChatCount: 2, active: { ...base.active!, source: 'telegram', pendingMessages: [{ id: 'next', text: 'Describe ferns' }] } })
    expect(provider.getSnapshot(context).items).toMatchObject({ running: { text: 'Running chats: 2' }, queued: { text: 'Queued messages: 1' }, source: { text: 'Telegram' } })
    snapshot.mockRestore()
    const changed = vi.fn(), unsubscribe = provider.subscribe(changed)
    store.newChat()
    expect(changed).toHaveBeenCalled()
    expect(provider.getSnapshot(context).items.status.text).toBe('Ready')
    expect(provider.getSnapshot(context).items.model.text).toBe('Auto')
    unsubscribe()
    await dispose?.(); dispose = undefined
    expect(mock.api.interop.extensions.providers(WORKSPACE_DETAILS_V1)).toEqual([])
  })

  it('delegates transcript math, links, embeds and code to the native read-only Markdown view', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    const value = '# Canopy\n\n$a^2+b^2=c^2$\n\n[[Forest canopy]]\n\n![[Media/fern.png]]\n\n```ts\nconst canopy = 2\n```'
    const NativeMarkdown = mock.api.ui.MarkdownView
    const markdown = vi.fn((props: MarkdownViewProps) => <NativeMarkdown {...props} />)
    Object.assign(mock.api.ui, { MarkdownView: markdown })
    const renderHtml = vi.spyOn(mock.api.markdown, 'render')
    mock.chatThreads.set('canopy', { id: 'canopy', title: 'Canopy', createdAt: 1, updatedAt: 1, messages: [{ role: 'assistant', content: value }], mode: 'plan', plan: { id: 'plan-canopy', revision: 1, status: 'review', text: value, directory: '.valley/plugins/data/assistant/plans/canopy' } })
    dispose = register(mock.api)
    const store = getStore(mock.api)
    await store.whenReady
    await store.openChat('canopy')
    const views = new Map(vi.mocked(mock.api.registerView).mock.calls)
    const Sidebar = views.get(config.uiSlots.right_sidebar) as React.ComponentType
    const view = render(<Sidebar />)
    await act(async () => {})
    expect(markdown).toHaveBeenCalledWith(expect.objectContaining({ value, context: {} }), expect.anything())
    expect(markdown.mock.calls[0][0].onChange).toBeUndefined()
    expect(renderHtml).not.toHaveBeenCalled()
    expect(view.getByRole('button', { name: 'Copy message' })).toBeInTheDocument()
    const dock = view.container.querySelector('.assistant-composer-dock')!
    expect(dock.querySelector('.assistant-plan-review')).toBeInTheDocument()
    expect(dock.querySelector('.assistant-voice-entry')).toBeNull()
  })
  it('opens the chat from Content Search without sending a message and releases its opener', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    mock.chatThreads.set('canopy', { id: 'canopy', title: 'Canopy report', createdAt: 1, updatedAt: 1, messages: [{ role: 'user', content: 'Rare orchid habitat.' }] })
    mock.chatThreads.set('meadow', { id: 'meadow', title: 'Meadow report', createdAt: 2, updatedAt: 2, messages: [] })
    dispose = register(mock.api)
    const store = getStore(mock.api)
    const send = vi.spyOn(store, 'send')
    const open = vi.spyOn(mock.api.workspace, 'openMainTab')
    const card = mock.api.interop.extensions.providers(SEARCH_RESULT_ACTION_V1)[0].extension
    expect(card).not.toHaveProperty('render')
    expect(await card.open({ id: 'canopy' }, { newTab: true })).toBe(true)
    expect(store.getSnapshot().active).toMatchObject({ id: 'canopy' })
    const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).find(({ extension }) => extension.surface === 'main_workspace')!.extension
    await surface.restore({ chatId: 'meadow' }, undefined, { background: true })
    expect(store.getSnapshot().active).toMatchObject({ id: 'canopy' })
    await surface.restore({ chatId: 'meadow' })
    expect(store.getSnapshot().active).toMatchObject({ id: 'meadow' })
    expect(open).toHaveBeenCalledWith({ newTab: true })
    expect(send).not.toHaveBeenCalled()
    open.mockClear()
    expect(await card.open({ id: 'missing' }, {})).toBe(false)
    expect(open).not.toHaveBeenCalled()
    await dispose?.()
    dispose = undefined
    expect(mock.api.interop.extensions.providers(SEARCH_RESULT_ACTION_V1)).toEqual([])
  })

  it('renders the shared chat in the sidebar while only the main view owns navigation', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    mock.chatThreads.set('canopy', { id: 'canopy', title: 'Canopy report', createdAt: 1, updatedAt: 1, messages: [] })
    mock.chatThreads.set('meadow', { id: 'meadow', title: 'Meadow report', createdAt: 2, updatedAt: 2, messages: [] })
    dispose = register(mock.api)
    const store = getStore(mock.api)
    await store.whenReady
    await store.openChat('canopy')
    await store.openChat('meadow')
    const views = new Map(vi.mocked(mock.api.registerView).mock.calls)
    const Sidebar = views.get(config.uiSlots.right_sidebar) as React.ComponentType
    const Main = views.get(config.uiSlots.main_workspace) as React.ComponentType<MainWorkspaceViewProps>
    expect(Sidebar).toBeDefined()
    expect(Main).toBeDefined()

    const sidebar = render(<Sidebar />)
    expect(sidebar.container.querySelector('.assistant-page-title')).toHaveTextContent('Meadow report')
    expect(sidebar.container.querySelector('.assistant-messages')).toBeInTheDocument()
    expect(sidebar.container.querySelector('textarea')).toBeInTheDocument()

    const setController = vi.fn<MainWorkspaceNavigation['setController']>()
    const main = render(<Main navigation={{ setController }} />)
    expect(setController).toHaveBeenLastCalledWith(expect.objectContaining({ canGoBack: true, canGoForward: false }))
    await act(async () => { await setController.mock.calls.at(-1)?.[0]?.goBack() })
    expect(main.container.querySelector('.assistant-page-title')).toHaveTextContent('Canopy report')
    expect(sidebar.container.querySelector('.assistant-page-title')).toHaveTextContent('Canopy report')
    expect(setController).toHaveBeenLastCalledWith(expect.objectContaining({ canGoForward: true }))

    const callsBeforeSidebarUnmount = setController.mock.calls.length
    sidebar.unmount()
    expect(setController).toHaveBeenCalledTimes(callsBeforeSidebarUnmount)
    main.unmount()
    expect(setController).toHaveBeenLastCalledWith(null)
  })
  it('saves the exact model connection and rejects a legacy harness edit', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    mock.chatThreads.set('canopy', { id: 'canopy', title: 'Canopy', createdAt: 1, updatedAt: 1, messages: [] })
    dispose = register(mock.api)
    await getStore(mock.api).whenReady
    await expect(updateConversation(mock.api, 'canopy', { harness: 'openai-modified' })).rejects.toThrow()
    await updateConversation(mock.api, 'canopy', { model: { provider: 'openai', model: 'canopy-model', connectionId: 'canopy-connection' } })
    expect(mock.chatThreads.get('canopy')).toMatchObject({ model: { connectionId: 'canopy-connection' } })
  })

  it('puts a starter in the composer without sending or replacing an existing draft', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    dispose = register(mock.api)
    const store = getStore(mock.api)
    await store.whenReady
    const views = new Map(vi.mocked(mock.api.registerView).mock.calls)
    const Sidebar = views.get(config.uiSlots.right_sidebar) as React.ComponentType
    const view = render(<Sidebar />)
    await act(async () => {})
    const send = vi.spyOn(store, 'send')
    fireEvent.click(view.getByRole('button', { name: 'Explore notes' }))
    const input = view.getByRole('textbox', { name: 'Message Assistant' })
    expect(input).toHaveValue('Help me explore my notes about…')
    expect(input).toHaveFocus()
    expect(send).not.toHaveBeenCalled()
    expect(view.getByRole('button', { name: 'Draft something' })).toBeDisabled()
    fireEvent.change(input, { target: { value: '' } })
    expect(view.getByRole('button', { name: 'Draft something' })).toBeEnabled()
  })

  it('attaches uploads to the selected chat after switching conversations', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    for (const id of ['canopy', 'meadow']) mock.chatThreads.set(id, { id, title: id, createdAt: 1, updatedAt: 1, messages: [] })
    dispose = register(mock.api)
    const store = getStore(mock.api)
    await store.whenReady
    await store.openChat('canopy')
    const Sidebar = new Map(vi.mocked(mock.api.registerView).mock.calls).get(config.uiSlots.right_sidebar) as React.ComponentType
    const view = render(<Sidebar />)
    await act(async () => { await store.openChat('meadow') })
    const attachment = { kind: 'image', fileName: 'moss.png', path: 'attachments/moss.png', mime: 'image/png' }
    const original = mock.api.backend.call
    mock.api.backend.call = vi.fn(async (method, args) => {
      if (method === 'attachments.begin') return 'upload'
      if (method === 'attachments.finish') return attachment
      return original(method, args)
    }) as typeof original
    await act(async () => {
      fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File([], 'moss.png', { type: 'image/png' })] } })
    })
    expect(store.getDraft('meadow').attachments).toEqual([attachment])
    expect(store.getDraft('canopy').attachments).toEqual([])
  })

  it('keeps the chosen connection when models share an id', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    const result = await mock.api.assistant.getConfig()
    const configValue = result.data!
    configValue.connections = ['forest', 'meadow'].map(id => ({
      id, provider: 'openai', label: id, providerName: 'OpenAI', providerDescription: '', providerIcon: '',
      requiresKey: true, providerCapabilities: [], baseUrl: '', configured: true, authMode: 'key' as const,
      models: [{ provider: 'openai', id: 'shared-model', label: `${id} model` }], createdAt: 1
    }))
    mock.chatThreads.set('canopy', { id: 'canopy', title: 'Canopy report', createdAt: 1, updatedAt: 1, messages: [] })
    dispose = register(mock.api)
    const store = getStore(mock.api)
    await store.whenReady
    await store.openChat('canopy')
    const views = new Map(vi.mocked(mock.api.registerView).mock.calls)
    const Sidebar = views.get(config.uiSlots.right_sidebar) as React.ComponentType
    const view = render(<Sidebar />)
    await act(async () => {})
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Select model' })) })
    fireEvent.click(document.querySelector<HTMLButtonElement>('.assistant-effort-model')!)
    const picker = view
    expect(picker.queryByRole('textbox', { name: 'Search models…' })).toBeNull()
    fireEvent.keyDown(picker.getByRole('option', { name: 'forest model' }), { key: 'ArrowDown' })
    const option = picker.getByRole('option', { name: 'meadow model' })
    expect(option).toHaveFocus()
    fireEvent.click(option)
    expect(store.getSnapshot().active?.model).toEqual({ provider: 'openai', model: 'shared-model', connectionId: 'meadow' })
    fireEvent.keyDown(document.querySelector('.assistant-effort-model')!, { key: 'Escape' })
    expect(view.getByRole('button', { name: 'Select model' })).toHaveTextContent('meadow model')
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Select model' })) })
    fireEvent.click(document.querySelector<HTMLButtonElement>('.assistant-effort-model')!)
    expect(picker.getByRole('option', { name: 'meadow model' })).toHaveFocus()
  })

  it('updates existing message dates when core preferences change', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    mock.emitState({ dateFormat: 'dd.mm.yyyy', timeFormat: '24h' })
    mock.chatThreads.set('canopy', { id: 'canopy', title: 'Canopy', createdAt: 1, updatedAt: 1, messages: [
      { role: 'user', content: 'Describe the canopy.', ts: new Date(2025, 0, 2, 15, 4).getTime() }
    ] })
    dispose = register(mock.api)
    const store = getStore(mock.api)
    await store.whenReady
    await store.openChat('canopy')
    const Sidebar = new Map(vi.mocked(mock.api.registerView).mock.calls).get(config.uiSlots.right_sidebar) as React.ComponentType
    const view = render(<Sidebar />)
    await act(async () => {})
    expect(view.container.querySelector('time')).toHaveTextContent('02.01.2025 · 15:04')
    act(() => mock.emitState({ dateFormat: 'mm/dd/yyyy', timeFormat: '12h' }))
    expect(view.container.querySelector('time')).toHaveTextContent('01/02/2025 · 3:04 PM')
  })

  it('keeps a file drop overlay across child transitions and attaches once from the transcript', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    mock.chatThreads.set('canopy', { id: 'canopy', title: 'Canopy', createdAt: 1, updatedAt: 1, messages: [] })
    dispose = register(mock.api)
    const store = getStore(mock.api)
    await store.whenReady
    await store.openChat('canopy')
    const Sidebar = new Map(vi.mocked(mock.api.registerView).mock.calls).get(config.uiSlots.right_sidebar) as React.ComponentType
    const view = render(<Sidebar />)
    await act(async () => {})
    const body = view.container.querySelector('.assistant-chat-body')!
    const input = view.getByRole('textbox', { name: 'Message Assistant' })
    fireEvent.dragEnter(body, { dataTransfer: { types: ['text/plain'] } })
    expect(view.queryByText('Drop to attach')).toBeNull()
    const dataTransfer = { types: ['Files'], files: [new File([], 'moss.png', { type: 'image/png' })] }
    fireEvent.dragEnter(body, { dataTransfer })
    fireEvent.dragEnter(input, { dataTransfer })
    fireEvent.dragLeave(input, { dataTransfer })
    expect(view.getByText('Drop to attach')).toBeInTheDocument()
    fireEvent.dragLeave(body, { dataTransfer })
    expect(view.queryByText('Drop to attach')).toBeNull()
    fireEvent.dragEnter(body, { dataTransfer })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(view.queryByText('Drop to attach')).toBeNull()
    fireEvent.dragEnter(body, { dataTransfer })
    const attachment = { kind: 'image', fileName: 'moss.png', path: 'attachments/moss.png', mime: 'image/png' }
    const original = mock.api.backend.call
    mock.api.backend.call = vi.fn(async (method, args) => {
      if (method === 'attachments.begin') return 'upload'
      if (method === 'attachments.finish') return attachment
      return original(method, args)
    }) as typeof original
    await act(async () => { fireEvent.drop(view.container.querySelector('.assistant-messages')!, { dataTransfer }) })
    expect(view.queryByText('Drop to attach')).toBeNull()
    expect(store.getDraft('canopy').attachments).toEqual([attachment])
  })

  it('lets the host own transcript scrolling and requests the latest message without stealing reading position', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    const NativePanel = mock.api.ui.ScrollPanel
    const panel = vi.fn((props: UiScrollPanelProps) => <NativePanel {...props} />)
    mock.api.ui.ScrollPanel = panel
    mock.chatThreads.set('canopy', { id: 'canopy', title: 'Canopy', createdAt: 1, updatedAt: 1, messages: [{ role: 'user', content: 'Describe moss.' }] })
    dispose = register(mock.api)
    const store = getStore(mock.api)
    await store.whenReady
    await store.openChat('canopy')
    const Sidebar = new Map(vi.mocked(mock.api.registerView).mock.calls).get(config.uiSlots.right_sidebar) as React.ComponentType
    const view = render(<Sidebar />)
    await act(async () => {})
    const props = () => panel.mock.calls.at(-1)![0]
    expect(props()).toMatchObject({ fill: true, followEnd: true })
    const original = props().scrollToEndKey
    act(() => props().onAtEndChange?.(false))
    mock.chatThreads.get('canopy')!.messages.push({ role: 'assistant', content: 'Moss retains water.' })
    await act(async () => { await store.openChat('canopy') })
    expect(props().scrollToEndKey).toBe(original)
    fireEvent.click(view.getByRole('button', { name: 'Go to latest message' }))
    expect(props().scrollToEndKey).not.toBe(original)
    act(() => props().onAtEndChange?.(true))
    expect(view.queryByRole('button', { name: 'Go to latest message' })).toBeNull()
    expect(view.getByRole('textbox', { name: 'Message Assistant' })).toHaveFocus()
  })

  it('unmounts Markdown commentary when work details are collapsed', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    mock.chatThreads.set('canopy', { id: 'canopy', title: 'Canopy', createdAt: 1, updatedAt: 1, messages: [
      { role: 'user', content: 'Describe moss.', ts: 1 },
      { role: 'assistant', content: 'Inspecting the canopy.', ts: 2 },
      { role: 'assistant', content: 'Moss retains water.', ts: 3 }
    ] })
    dispose = register(mock.api)
    const store = getStore(mock.api)
    await store.whenReady
    await store.openChat('canopy')
    const Sidebar = new Map(vi.mocked(mock.api.registerView).mock.calls).get(config.uiSlots.right_sidebar) as React.ComponentType
    const view = render(<Sidebar />)
    const group = view.container.querySelector<HTMLDetailsElement>('.assistant-activity-group')!
    expect(view.queryByText('Inspecting the canopy.')).toBeNull()
    await act(async () => { group.open = true; fireEvent(group, new Event('toggle')) })
    expect(view.getByText('Inspecting the canopy.')).toBeInTheDocument()
    await act(async () => { group.open = false; fireEvent(group, new Event('toggle')) })
    expect(view.queryByText('Inspecting the canopy.')).toBeNull()
    expect(view.getByText('Moss retains water.')).toBeInTheDocument()
  })

  it('renders message prose with the note reading view typography while work details stay compact', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    const NativeMarkdown = mock.api.ui.MarkdownView
    const markdown = vi.fn((props: MarkdownViewProps) => <NativeMarkdown {...props} />)
    Object.assign(mock.api.ui, { MarkdownView: markdown })
    const reply = '## Mosses\n\nTwo plots hold `Sphagnum`.\n\n- Plot A\n- Plot B\n\n| Plot | Moss |\n| --- | --- |\n| A | Sphagnum |'
    mock.chatThreads.set('canopy', { id: 'canopy', title: 'Canopy', createdAt: 1, updatedAt: 1, messages: [
      { role: 'user', content: 'Which **mosses** grow here?', ts: 1 },
      { role: 'assistant', content: 'Surveying the plots.', ts: 2, toolCalls: [{ id: 'grep', name: 'command', arguments: { command: 'grep -rn moss plots' } }] },
      { role: 'tool', content: '{"hits":2}', toolCallId: 'grep', name: 'command', ts: 3 },
      { role: 'assistant', content: 'Two plots mention moss.', ts: 4 },
      { role: 'assistant', content: reply, ts: 5 }
    ] })
    dispose = register(mock.api)
    const store = getStore(mock.api)
    await store.whenReady
    await store.openChat('canopy')
    const views = new Map(vi.mocked(mock.api.registerView).mock.calls)
    const Sidebar = views.get(config.uiSlots.right_sidebar) as React.ComponentType
    const Main = views.get(config.uiSlots.main_workspace) as React.ComponentType<MainWorkspaceViewProps>
    for (const view of [render(<Sidebar />), render(<Main navigation={{ setController: vi.fn() }} />)]) {
      await act(async () => {})
      const prose = [...view.container.querySelectorAll('.assistant-msg .markdown-body')]
      expect(prose.map(element => element.textContent)).toEqual(['Which mosses grow here?', 'Surveying the plots.', expect.stringContaining('Two plots hold Sphagnum.')])
      for (const element of prose) expect(element).toHaveClass('assistant-message-markdown')
      const group = view.container.querySelector<HTMLDetailsElement>('.assistant-activity-group')!
      await act(async () => { group.open = true; fireEvent(group, new Event('toggle')) })
      const commentary = within(group).getByText('Two plots mention moss.').closest('.markdown-body')!
      expect(commentary.closest('.assistant-activity-commentary')).not.toBeNull()
      expect(commentary).not.toHaveClass('assistant-message-markdown')
      const tool = group.querySelector('.assistant-activity')!
      expect(tool.querySelector('.assistant-activity-output')).toHaveTextContent('{"hits":2}')
      expect(tool.querySelector('.markdown-body')).toBeNull()
      expect(group.querySelector('.assistant-message-markdown')).toBeNull()
      view.unmount()
    }
    const classes = new Map(markdown.mock.calls.map(([props]) => [props.value, props.className]))
    expect(Object.fromEntries(classes)).toEqual({ 'Which **mosses** grow here?': 'assistant-message-markdown', 'Surveying the plots.': 'assistant-message-markdown', 'Two plots mention moss.': undefined, [reply]: 'assistant-message-markdown' })

    const sheet = (document.getElementById('assistant-plugin-styles') as HTMLStyleElement).sheet!
    const rules = [...sheet.cssRules].filter((rule): rule is CSSStyleRule => 'selectorText' in rule)
    const declarations = (selector: string) => {
      const { style } = rules.find(rule => rule.selectorText === selector)!
      return Object.fromEntries(Array.from({ length: style.length }, (_, index) => [style[index], style.getPropertyValue(style[index]).trim()]))
    }
    expect(declarations('.md-embedded.assistant-message-markdown :is(.md-note, .markdown-body)')).toEqual({
      '--md-note-font': 'var(--markdown-font, var(--body-font))',
      '--md-note-size': 'var(--markdown-size, var(--text-font-size))',
      '--md-note-line': 'var(--markdown-line-height, 1.65)',
      '--md-block-gap': 'var(--markdown-paragraph-spacing, 1em)',
      '--md-heading-gap': 'var(--markdown-heading-spacing, 1em)',
      ...Object.fromEntries(['heading-spacing', 'h1-size', 'h2-size', 'h3-size', 'h4-size', 'h5-size', 'h6-size', 'mono-size', 'inline-code-size', 'table-size'].map(name => [`--markdown-${name}`, 'unset']))
    })
    expect(declarations('.md-embedded.assistant-message-markdown .md-reading')).toEqual({ 'font-family': 'var(--md-note-font)', 'font-size': 'var(--md-note-size)', 'line-height': 'var(--md-note-line)' })
    expect(declarations('.assistant-bubble.assistant-streaming')).toEqual({ 'font-family': 'var(--markdown-font, var(--body-font))', 'font-size': 'var(--markdown-size, var(--text-font-size))', 'line-height': 'var(--markdown-line-height, 1.65)' })
    expect(rules.filter(rule => rule.selectorText.includes('.md-embedded')).every(rule => rule.selectorText.includes('.assistant-message-markdown'))).toBe(true)
  })

  it('switches between project navigation and searchable date groups with saved time mode', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    const now = new Date(), yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12)
    mock.chatThreads.set('canopy', { id: 'canopy', title: 'Canopy report', createdAt: 1, updatedAt: now.getTime(), messages: [{ role: 'assistant', content: 'Moss stores water.' }] })
    mock.chatThreads.set('meadow', { id: 'meadow', title: 'Meadow report', createdAt: 1, updatedAt: yesterday.getTime(), messages: [{ role: 'assistant', content: 'Flowers attract insects.' }] })
    dispose = register(mock.api)
    await getStore(mock.api).whenReady
    const Panel = new Map(vi.mocked(mock.api.registerView).mock.calls).get(config.uiSlots.left_sidebar) as React.ComponentType
    const view = render(<Panel />)
    await act(async () => {})
    expect(view.getByRole('button', { name: 'Projects' })).toBeVisible()
    expect(view.queryByText('Moss stores water.')).toBeNull()
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Sort by time' })) })
    expect(mock.api.settings.get().sidebarChronological).toBe(true)
    expect(view.getByRole('heading', { name: 'Today' })).toBeVisible()
    expect(view.getByRole('heading', { name: 'Yesterday' })).toBeVisible()
    expect(view.getByText('Moss stores water.')).toBeVisible()
    fireEvent.change(view.getByRole('textbox', { name: 'Search chats' }), { target: { value: 'insects' } })
    expect(view.queryByRole('button', { name: /Canopy report/ })).toBeNull()
    expect(view.getByText('Flowers attract insects.')).toBeVisible()
    fireEvent.keyDown(view.getByRole('textbox', { name: 'Search chats' }), { key: 'Escape' })
    expect(view.getByText('Moss stores water.')).toBeVisible()
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Sort by time' })) })
    expect(view.getByRole('button', { name: 'Projects' })).toBeVisible()
    fireEvent.click(view.getByRole('button', { name: 'Canopy report' }))
    await act(async () => {})
    expect(mock.api.workspace.openMainTab).toHaveBeenCalled()
  })

})
