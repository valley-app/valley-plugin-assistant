import * as React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MainWorkspaceNavigation, MainWorkspaceViewProps, MarkdownViewProps } from '@valley/plugin-sdk'
import { PLUGIN_SURFACE_V1, SEARCH_RESULT_ACTION_V1 } from '@valley/plugin-sdk'
import { createMockValleyApi } from './mock'
import config from '../config.json'
import { register } from '../src/index'
import { getStore } from '../src/store'
import { updateConversation } from '../src/commands'

let dispose: (() => void) | undefined
afterEach(() => { cleanup(); dispose?.(); dispose = undefined })

describe('declared Assistant view slots', () => {
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
    expect(dock.querySelector('.assistant-voice-entry')).toBeInTheDocument()
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

  it('preserves the reading position as output grows until jumping to the latest message', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    mock.chatThreads.set('canopy', { id: 'canopy', title: 'Canopy', createdAt: 1, updatedAt: 1, messages: [{ role: 'user', content: 'Describe moss.' }] })
    dispose = register(mock.api)
    const store = getStore(mock.api)
    await store.whenReady
    await store.openChat('canopy')
    const Sidebar = new Map(vi.mocked(mock.api.registerView).mock.calls).get(config.uiSlots.right_sidebar) as React.ComponentType
    const view = render(<Sidebar />)
    await act(async () => {})
    const transcript = view.container.querySelector('.assistant-messages')!
    let height = 1000
    Object.defineProperties(transcript, { scrollHeight: { get: () => height }, clientHeight: { value: 300 } })
    transcript.scrollTop = 700
    fireEvent.scroll(transcript)
    expect(view.queryByRole('button', { name: 'Go to latest message' })).toBeNull()
    transcript.scrollTop = 200
    fireEvent.scroll(transcript)
    height = 1200
    mock.chatThreads.get('canopy')!.messages.push({ role: 'assistant', content: 'Moss retains water.' })
    await act(async () => { await store.openChat('canopy') })
    expect(transcript.scrollTop).toBe(200)
    fireEvent.click(view.getByRole('button', { name: 'Go to latest message' }))
    expect(transcript.scrollTop).toBe(1200)
    expect(view.queryByRole('button', { name: 'Go to latest message' })).toBeNull()
    expect(view.getByRole('textbox', { name: 'Message Assistant' })).toHaveFocus()
    height = 1400
    mock.chatThreads.get('canopy')!.messages.push({ role: 'assistant', content: 'Its leaves absorb rain.' })
    await act(async () => { await store.openChat('canopy') })
    expect(transcript.scrollTop).toBe(1400)
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
