import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AiChatThread, ChannelInfo } from '../src/types'
import type { RunAgentOptions } from '../src/agent/loop'

vi.mock('../src/agent/loop', () => ({ friendlyStreamError: (error: string) => error,
  runAgent: async (opts: RunAgentOptions) => opts.onMessage({ role: 'assistant', content: 'ok' }),
  streamOnce: async () => ({ text: '', toolCalls: [] })
}))

import { createMockValleyApi as createBaseMock } from './mock'
import { initRuntime } from '../src/runtime'
import { getStore, disposeStore } from '../src/store'
import { settingsSchema } from '../src/backend/configuration/settings'
import { speechSchema } from '../src/backend/configuration/schemas'
import { ChatDetail, Settings } from '../src/Settings'
import { registerAssistantCommands } from '../src/commands'
import { registerAssistantSurfaces } from '../src/surfaces'
import { METADATA_PANEL_SEGMENT_V1, PLUGIN_SURFACE_V1 } from '@valley/plugin-sdk'
import { initLocalization, uiText } from '../src/localization'

const root = '.valley/plugins/data/assistant'
function createMockValleyApi(options: Parameters<typeof createBaseMock>[0] = {}) {
  const mock = createBaseMock(options), original = mock.api.backend.call.bind(mock.api.backend)
  mock.api.backend.call = vi.fn(async (method: string, input?: unknown) => {
    if (method === 'configuration.settings') return { revision: 0, values: settingsSchema.parse(mock.api.settings.get()) }
    if (method === 'configuration.speech') return { revision: 0, values: speechSchema.parse({}) }
    if (method === 'configuration.set') { const { key, value } = input as { key: string; value: unknown }; await mock.api.settings.set(key, value); return { revision: 0, values: settingsSchema.parse(mock.api.settings.get()) } }
    if (method === 'configuration.note') return { path: `${root}/instructions/global.md`, body: 'Discover tools and read plugin help.', includes: [], revision: 0, hash: 'a'.repeat(64), settingsRevision: 0 }
    if (method === 'configuration.note.set') return { ...(input as object), path: `${root}/instructions/global.md` }
    if (method === 'configuration.status') {
      const scope = input as { scope?: string; id?: string }
      const notes = scope.scope === 'conversation' ? [{ id: 'conversation', group: 'instructions', path: `${root}/chats/${scope.id}/settings.md` }]
        : scope.scope === 'channel' ? [{ id: 'channel', group: 'instructions', path: `${root}/config/channels/${scope.id}.md` }]
        : scope.scope === 'chat' ? [{ id: 'defaults', group: 'files', path: `${root}/settings.md` }, { id: 'chatNaming', group: 'instructions', key: 'chatNaming', path: `${root}/instructions/chat-naming.md` }]
        : [{ id: 'home', group: 'files', path: `${root}/README.md` }, { id: 'global', group: 'instructions', key: 'global', path: `${root}/instructions/global.md` }]
      return { notes, diagnostics: [], settingsRevision: 0 }
    }
    return original(method, input)
  }) as typeof mock.api.backend.call
  return mock
}

afterEach(() => {
  cleanup()
  disposeStore()
})

const channel = (id: string, name: string, patch: Partial<ChannelInfo> = {}): ChannelInfo => ({
  id,
  type: 'telegram',
  name,
  displayName: name,
  configured: true,
  running: true,
  connected: patch.configured !== false,
  ...patch
})

const mirror = (id: string, title: string, channelId: string): AiChatThread => ({
  id,
  title,
  createdAt: 1,
  updatedAt: 1,
  messages: [],
  source: 'telegram',
  channelId,
  chatRef: '1',
  channelName: 'Field bot'
})

/** Mount one settings section against a seeded mock and wait for its content. */
async function mountSection(
  section: string,
  options: Parameters<typeof createMockValleyApi>[0] = {}
): Promise<{ container: HTMLElement; mock: ReturnType<typeof createMockValleyApi> }> {
  const mock = createMockValleyApi(options)
  for (const t of options.channels?.length ? [mirror('t1', 'Field notes', options.channels[0].id)] : []) {
    mock.chatThreads.set(t.id, t)
  }
  initRuntime(mock.api)
  getStore(mock.api)
  const { container } = render(<Settings section={section} />)
  await waitFor(() => expect(container.querySelector('.assistant-settings')?.textContent).toBeTruthy())
  if (section === 'chat') await screen.findByLabelText('Attachment folder')
  if (section === 'settings') await screen.findByRole('switch', { name: 'Show Telegram in sidebar' })
  return { container, mock }
}

describe('assistant settings — parent pane', () => {
  it('offers dedicated instruction and voice subsettings in General', async () => {
    const { container } = await mountSection('settings')
    expect(container.textContent).toContain('Personalities')
    expect(screen.getByRole('button', { name: /Voice Provider/ })).toBeTruthy()
    expect(screen.queryByLabelText('Voice provider')).toBeNull()
    expect(screen.queryByLabelText('Attachment reader')).toBeNull()
    expect(container.textContent).not.toContain('Defaults and appearance')
  })

  it('edits instructions on a dedicated page and keeps the source note accessible', async () => {
    const { mock } = await mountSection('instructions')
    fireEvent.click(await screen.findByText('Global instructions'))
    const editor = await screen.findByRole('textbox', { name: 'Instructions' })
    expect(editor).toHaveValue('Discover tools and read plugin help.')
    expect(screen.queryByRole('combobox', { name: 'Additional instruction notes' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Additional instruction notes' }))
    expect(screen.getByRole('combobox', { name: 'Additional instruction notes' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Additional instruction notes' }))
    expect(screen.queryByRole('combobox', { name: 'Additional instruction notes' })).toBeNull()
    fireEvent.change(editor, { target: { value: 'Read plugin help and verify results.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mock.api.backend.call).toHaveBeenCalledWith('configuration.note.set', expect.objectContaining({ body: 'Read plugin help and verify results.', expectedRevision: 0 })))
    fireEvent.click(screen.getByRole('button', { name: 'Open instruction note' }))
    expect(mock.api.workspace.openFile).toHaveBeenCalledWith(`${root}/instructions/global.md`)
  })

  it('renders the voice provider only in its own subsetting', async () => {
    await mountSection('voice')
    expect(await screen.findByLabelText('Voice provider')).toBeTruthy()
    expect(screen.queryByLabelText('Attachment folder')).toBeNull()
  })

  it('leaves subscription controls to Home', async () => {
    await mountSection('settings')
    expect(screen.queryByLabelText('Subscriptions')).toBeNull()
    expect(screen.queryByLabelText('Codex')).toBeNull()
    expect(screen.queryByLabelText('Claude')).toBeNull()
  })

  it('saves channel visibility in General', async () => {
    const { mock } = await mountSection('settings')
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Show Telegram in sidebar' })) })
    expect(mock.api.settings.get().showTelegram).toBe(false)
  })
})

describe('assistant settings — channel list page', () => {
  it('renders connections as shared list rows under a header band with +', async () => {
    const { container } = await mountSection('telegram', {
      channels: [channel('telegram', 'Field bot'), channel('telegram-2', 'Reading bot', { running: false, configured: false })]
    })
    await waitFor(() => expect(container.querySelectorAll('.settings-list-row').length).toBe(2))

    expect(container.querySelector('.settings-listpage-header')).toBeTruthy()
    expect(screen.getByLabelText('Add connection')).toBeTruthy()
    const names = [...container.querySelectorAll('.settings-list-name')].map((n) => n.textContent)
    expect(names).toEqual(['Field bot', 'Reading bot'])
    const subs = [...container.querySelectorAll('.settings-list-sub')].map((n) => n.textContent)
    expect(subs[0]).toContain('Connected')
    expect(subs[1]).toContain('Not connected')
  })

  it('shows the connection list alone — no setup card, no commands card', async () => {
    const { container } = await mountSection('telegram', { channels: [channel('telegram', 'Field bot')] })
    await waitFor(() => expect(container.querySelectorAll('.settings-list-row').length).toBe(1))

    expect(container.textContent).not.toContain('Telegram bot setup')
    expect(container.textContent).not.toContain('BotFather')
    expect(container.querySelectorAll('.assistant-provider')).toHaveLength(0)
    expect(container.querySelectorAll('.settings-listpage')).toHaveLength(1)
  })

  it('opens a connection into a detail page led by the back band', async () => {
    const { container } = await mountSection('telegram', { channels: [channel('telegram', 'Field bot')] })
    await waitFor(() => expect(container.querySelectorAll('.settings-list-row').length).toBe(1))

    fireEvent.click(container.querySelector('.settings-list-row')!)
    await waitFor(() => expect(container.querySelector('.settings-listpage-crumbs')).toBeTruthy())
    expect(container.querySelector('.settings-crumb-current')?.textContent).toBe('Field bot')
    expect(screen.getByLabelText('Bot token')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Back to Telegram'))
    await waitFor(() => expect(container.querySelector('.settings-listpage-crumbs')).toBeNull())
    expect(container.querySelectorAll('.settings-list-row').length).toBe(1)
  })

  it('keeps connection Settings focused on credentials and identity', async () => {
    const { container, mock } = await mountSection('telegram', { channels: [channel('telegram', 'Field bot')] })
    fireEvent.click(await screen.findByText('Field bot'))
    const token = await screen.findByLabelText('Bot token')
    expect(token).toHaveAttribute('type', 'password')
    expect(screen.queryByText('Connection instructions')).toBeNull()
    expect(screen.queryByLabelText('Default model')).toBeNull()
    fireEvent.change(token, { target: { value: 'fixture-token' } })
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Save' }).find(button => !(button as HTMLButtonElement).disabled)!) })
    expect(mock.driverCalls).toContainEqual(expect.objectContaining({ method: 'setSecret', payload: { channelId: 'telegram', secret: 'fixture-token' } }))
    expect(token).toHaveValue('')
    expect(container.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('places a single save button and normalized red errors after connection fields', async () => {
    const { container } = await mountSection('telegram', { channels: [channel('telegram', 'Field bot', { error: "Error: Error invoking remote method 'plugins:callBackend': Error: Telegram failed (404)" })] })
    fireEvent.click(await screen.findByText('Field bot'))
    expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1)
    const footer = container.querySelector('.assistant-connection-footer')!
    expect(footer.querySelector('button')).toHaveClass('assistant-connection-save')
    expect(footer.querySelector('[role="alert"]')).toHaveTextContent('Telegram failed (404)')
    expect(footer.querySelector('[role="alert"]')).not.toHaveTextContent('remote method')
  })

  it('saves connection names and allowed senders through the existing channel API', async () => {
    const { mock } = await mountSection('telegram', { channels: [channel('telegram', 'Field bot', { allowFrom: ['fern'] })] })
    fireEvent.click(await screen.findByText('Field bot'))
    const name = await screen.findByRole('textbox', { name: 'Name' })
    fireEvent.change(name, { target: { value: 'Meadow bot' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(mock.driverCalls).toContainEqual(expect.objectContaining({ method: 'setConfig', payload: expect.objectContaining({ channelId: 'telegram', config: expect.objectContaining({ name: 'Meadow bot' }) }) }))
    const senders = screen.getByRole('textbox', { name: 'Allowed senders' })
    fireEvent.change(senders, { target: { value: 'fern, moss' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(mock.driverCalls).toContainEqual(expect.objectContaining({ method: 'setConfig', payload: expect.objectContaining({ channelId: 'telegram', config: expect.objectContaining({ allowFrom: ['fern', 'moss'] }) }) }))
  })

  it('reaches a connection detail with the keyboard', async () => {
    const { container } = await mountSection('telegram', { channels: [channel('telegram', 'Field bot')] })
    await waitFor(() => expect(container.querySelectorAll('.settings-list-row').length).toBe(1))

    fireEvent.keyDown(container.querySelector('.settings-list-row')!, { key: 'Enter' })
    await waitFor(() => expect(container.querySelector('.settings-crumb-current')?.textContent).toBe('Field bot'))
  })
})

describe('assistant settings — chat pane', () => {
  it('embeds the host field access control without saving an empty chat or mutating Guards', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    initRuntime(mock.api)
    initLocalization(mock.api)
    const store = getStore(mock.api)
    await store.whenReady
    await store.newChat()
    const thread = store.getSnapshot().active!
    const host = mock.accessControl, reload = vi.spyOn(store, 'reloadConfig')
    render(<ChatDetail summary={thread} personalities={[]} connections={[]} backTo="Chat" onBack={() => {}} onChanged={async () => {}} embedded />)
    const access = await screen.findByRole('button', { name: 'Host access control' })
    expect(host.mock.calls.at(-1)![0]).toMatchObject({ variant: 'field' })
    expect(Object.keys(host.mock.calls.at(-1)![0]).sort()).toEqual(['onChange', 'variant'])
    await act(async () => { fireEvent.click(access) })
    expect(reload).toHaveBeenCalledOnce()
    expect(mock.driverCalls.some(call => call.method === 'saveGuard')).toBe(false)
    expect(mock.chatThreads.size).toBe(0)
  })

  it('saves and deletes human conversation edits directly while commands use the same domain helpers', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    const thread = { id: 'canopy', title: 'Canopy report', createdAt: 1, updatedAt: 1, messages: [] }
    mock.chatThreads.set(thread.id, thread)
    initRuntime(mock.api)
    initLocalization(mock.api)
    await getStore(mock.api).whenReady
    const offCommands = registerAssistantCommands(mock.api)
    const dispatch = vi.spyOn(mock.api.commands, 'executeOwn')
    const execute = vi.spyOn(mock.api.commands, 'execute')
    const onBack = vi.fn()
    try {
      render(<ChatDetail summary={thread} personalities={[]} connections={[]} backTo="Chat" onBack={onBack} onChanged={async () => {}} />)
      const title = await screen.findByRole('textbox', { name: uiText('assistant.surface.title') })
      fireEvent.change(title, { target: { value: 'Meadow report' } })
      await act(async () => { fireEvent.blur(title) })
      expect(mock.chatThreads.get(thread.id)?.title).toBe('Meadow report')
      expect(dispatch).not.toHaveBeenCalled()
      expect(execute).not.toHaveBeenCalled()
      await act(async () => { expect(await mock.api.commands.executeOwn('update-chat', { id: thread.id, patch: { pinned: true } })).toMatchObject({ ok: true }) })
      expect(mock.chatThreads.get(thread.id)?.pinned).toBe(true)
      dispatch.mockClear()
      fireEvent.click(screen.getByRole('button', { name: uiText('auto.db9121e79c1c') }))
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: uiText('auto.c9f2829e382c') })) })
      expect(mock.chatThreads.has(thread.id)).toBe(false)
      expect(onBack).toHaveBeenCalledOnce()
      expect(dispatch).not.toHaveBeenCalled()
      expect(execute).not.toHaveBeenCalled()
    } finally { offCommands() }
  })

  it('awaits history navigation and keeps the current conversation and history position when its target is missing', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    const canopy = { id: 'canopy', title: 'Canopy report', createdAt: 1, updatedAt: 1, messages: [] }
    mock.chatThreads.set('canopy', canopy)
    mock.chatThreads.set('meadow', { ...canopy, id: 'meadow', title: 'Meadow report' })
    initRuntime(mock.api)
    const store = getStore(mock.api)
    await store.whenReady
    await store.openChat('canopy')
    await store.openChat('meadow')
    mock.chatThreads.delete('canopy')
    await expect(store.goBack()).rejects.toThrow()
    expect(store.getSnapshot()).toMatchObject({ active: { id: 'meadow' }, canGoBack: true, canGoForward: false })
    mock.chatThreads.set('canopy', canopy)
    await expect(store.goBack()).resolves.toBe(true)
    expect(store.getSnapshot()).toMatchObject({ active: { id: 'canopy' }, canGoForward: true })
    await expect(store.goForward()).resolves.toBe(true)
    expect(store.getSnapshot().active?.id).toBe('meadow')
  })

  it('restores an explicit conversation and edits its Properties without exposing human-only policy fields', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'assistant' } })
    mock.chatThreads.set('canopy', { id: 'canopy', title: 'Canopy report', createdAt: 1, updatedAt: 1, messages: [] })
    mock.chatThreads.set('meadow', { id: 'meadow', title: 'Meadow report', createdAt: 2, updatedAt: 2, messages: [] })
    initRuntime(mock.api)
    const store = getStore(mock.api)
    const offCommands = registerAssistantCommands(mock.api)
    const offSurfaces = registerAssistantSurfaces(mock.api)
    const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).find((provider) => provider.extension.surface === 'main_workspace')!.extension
    await surface.restore({ chatId: 'canopy' }, undefined, { background: true })
    expect(store.getSnapshot().active?.id).toBe('canopy')
    expect(mock.api.workspace.openMainTab).not.toHaveBeenCalled()
    const snapshot = surface.getSnapshot()!
    const subject = { pluginId: 'assistant', surface: 'main_workspace' as const, view: snapshot.view, item: snapshot.item }
    const properties = mock.api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)[0].extension
    expect(await properties.inspect?.({ relPath: '', kind: 'unsupported', subject })).toEqual(expect.arrayContaining([{ id: 'pinned', label: expect.any(String), value: false, type: 'boolean' }]))
    expect(await mock.api.commands.executeOwn('update-properties', { subject, values: { title: 'Canopy 2026', pinned: true } })).toMatchObject({ ok: true })
    expect(mock.chatThreads.get('canopy')).toMatchObject({ title: 'Canopy 2026', pinned: true })
    expect(mock.chatThreads.get('meadow')?.title).toBe('Meadow report')
    for (const values of [{ guard: { defaultWrite: { decision: 'allow' } } }, { dangerousMode: { enabled: true } }, { approvalToken: 'injected' }]) {
      expect(await mock.api.commands.executeOwn('update-properties', { subject, values })).toMatchObject({ ok: false })
      expect(await mock.api.commands.executeOwn('update-chat', { id: 'canopy', patch: values })).toMatchObject({ ok: false })
    }
    await expect(surface.restore({ chatId: 'deleted' })).rejects.toThrow('no longer exists')
    expect(store.getSnapshot().active?.id).toBe('canopy')
    expect(mock.driverCalls.some((call) => /Guard|Dangerous|Approval/.test(call.method) && !call.method.startsWith('get'))).toBe(false)
    offSurfaces(); offCommands()
  })

  it('edits new-chat defaults without duplicating General instruction and speech groups', async () => {
    const { container, mock } = await mountSection('chat')
    expect(container.textContent).toContain('New chats')
    expect(screen.queryByLabelText('Voice provider')).toBeNull()
    expect(screen.queryByText('Global instructions')).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Show Telegram in sidebar' })).toBeNull()
    expect(mock.chatThreads.size).toBe(0)
  })
  it('opens chat configuration without listing conversations', async () => {
    const { container, mock } = await mountSection('chat')
    expect(container.querySelector('.settings-list-row')).toBeNull()
    vi.spyOn(mock.api.files, 'revealInFinder')
    fireEvent.click(screen.getByRole('button', { name: 'Show folder' }))
    expect(mock.api.files.revealInFinder).toHaveBeenCalledWith(`${root}/chats`)
  })

  it('retains a failed preference draft and reports the error', async () => {
    const { mock } = await mountSection('chat')
    vi.spyOn(mock.api.settings, 'set').mockRejectedValue(new Error('Write failed'))
    const field = screen.getByRole('textbox', { name: 'Attachment folder' })
    fireEvent.change(field, { target: { value: 'meadow/media' } })
    await act(async () => { fireEvent.blur(field) })
    expect(await screen.findByRole('alert')).toHaveTextContent('Write failed')
    expect(field).toHaveValue('meadow/media')
  })

  it('refreshes preferences after external Markdown edits', async () => {
    const mock = createMockValleyApi()
    const changed: Array<(path: string) => void> = []
    vi.spyOn(mock.api.data.files, 'onChanged').mockImplementation(listener => { changed.push(listener); return () => {} })
    initRuntime(mock.api)
    render(<Settings section="chat" />)
    const field = await screen.findByRole('textbox', { name: 'Attachment folder' })
    await act(async () => { await mock.api.settings.set('attachmentFolder', 'meadow/images'); changed.forEach(listener => listener('settings.md')) })
    expect(field).toHaveValue('meadow/images')
  })
})
