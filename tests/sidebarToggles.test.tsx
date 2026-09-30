import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AiChatThread } from '../src/types'
import type { RunAgentOptions } from '../src/agent/loop'

/**
 * Settings → Assistant decides whether a remote channel appears in the Chats
 * sidebar at all. Switching one off has to take BOTH its filter button and its
 * thread group away — a filter with no visible button is a dead end.
 */
vi.mock('../src/agent/loop', () => ({ friendlyStreamError: (error: string) => error,
  runAgent: async (opts: RunAgentOptions) => opts.onMessage({ role: 'assistant', content: 'ok' }),
  streamOnce: async () => ({ text: '', toolCalls: [] })
}))

import { createMockValleyApi } from './mock'
import { initRuntime } from '../src/runtime'
import { getStore, disposeStore } from '../src/store'
import { Panel } from '../src/Panel'
import { Page } from '../src/Page'

afterEach(() => {
  cleanup()
  disposeStore()
})

const thread = (id: string, title: string, source?: AiChatThread['source']): AiChatThread => ({
  id,
  title,
  createdAt: 1,
  updatedAt: 1,
  messages: [],
  ...(source ? { source, channelId: source, chatRef: '1', channelName: `${source} bot`, channelIdentity: `${source} bot · Fern` } : {})
})

/** Mount the panel with one chat per source and the given plugin settings. */
async function mountPanel(settings: Record<string, unknown>) {
  const mock = createMockValleyApi({ settings })
  for (const t of [thread('c1', 'Local note'), thread('t1', 'Field notes', 'telegram'), thread('w1', 'Survey log', 'whatsapp')]) {
    mock.chatThreads.set(t.id, t)
  }
  mock.api.backend.call = vi.fn(async () => []) as typeof mock.api.backend.call
  vi.spyOn(mock.api.ui, 'openMenu')
  initRuntime(mock.api)
  getStore(mock.api)
  render(<Panel />)
  // The in-app chat is never hidden, so it is the signal that threads loaded.
  await waitFor(() => expect(screen.getByText('Local note')).toBeTruthy())
  return mock
}

describe('assistant sidebar — channel visibility', () => {
  it('shows channel choices but only Chat conversations by default', async () => {
    await mountPanel({})
    expect(screen.getByRole('button', { name: 'Telegram' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'WhatsApp' })).toBeVisible()
    expect(screen.queryByText('Survey log')).toBeNull()
  })

  it('takes a switched-off channel out of the header and the list', async () => {
    await mountPanel({ showTelegram: false })
    expect(screen.queryByRole('button', { name: 'Telegram' })).toBeNull()
    expect(screen.queryByText('Field notes')).toBeNull()
    // The other channel is untouched.
    expect(screen.getByRole('button', { name: 'WhatsApp' })).toBeVisible()
    expect(screen.queryByText('Survey log')).toBeNull()
  })

  it('can switch both off, leaving only the in-app conversations', async () => {
    await mountPanel({ showTelegram: false, showWhatsApp: false })
    expect(screen.queryByRole('button', { name: 'Telegram' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'WhatsApp' })).toBeNull()
    expect(screen.queryByText('Survey log')).toBeNull()
    expect(screen.getByText('Local note')).toBeTruthy()
  })

  it('returns to Chat when its channel is switched off under it', async () => {
    const mock = createMockValleyApi({ settings: { showTelegram: true } })
    for (const t of [thread('c1', 'Local note'), thread('t1', 'Field notes', 'telegram')]) mock.chatThreads.set(t.id, t)
    mock.api.backend.call = vi.fn(async () => []) as typeof mock.api.backend.call
  vi.spyOn(mock.api.ui, 'openMenu')
  initRuntime(mock.api)
    getStore(mock.api)
    const { rerender } = render(<Panel />)
    await waitFor(() => expect(screen.getByText('Local note')).toBeTruthy())

    // Filter down to Telegram only — the in-app chat drops out of the list.
    fireEvent.click(screen.getByRole('button', { name: 'Telegram' }))
    expect(screen.queryByText('Local note')).toBeNull()

    // Now switch Telegram off: the panel must fall back to showing everything
    // rather than an empty list with no button to undo it.
    ;(mock.api.settings.get() as Record<string, unknown>).showTelegram = false
    rerender(<Panel />)
    await waitFor(() => expect(screen.getByText('Local note')).toBeTruthy())
    expect(screen.queryByText('Field notes')).toBeNull()
  })
})


it('highlights a project chat only once and limits its folder to five until expanded', async () => {
  const mock = createMockValleyApi()
  const project = { id: 'forest', name: 'Forest', instructions: '', folders: [], createdAt: 1, updatedAt: 1 }
  for (let index = 1; index <= 7; index++) {
    const chat = { ...thread(`p${index}`, `Forest report ${index}`), projectId: project.id, updatedAt: 10 - index }
    mock.chatThreads.set(chat.id, chat)
  }
  mock.api.backend.call = vi.fn(async () => [project]) as typeof mock.api.backend.call
  initRuntime(mock.api)
  const store = getStore(mock.api)
  const { container } = render(<Panel />)
  await screen.findByRole('button', { name: 'Forest report 1' })
  await act(async () => { await store.openChat('p1') })
  const selected = () => container.querySelectorAll('.assistant-thread-row.active')
  const projectRows = () => container.querySelectorAll('.assistant-project-tree-chats .assistant-thread-row')
  await waitFor(() => expect(projectRows()).toHaveLength(5))
  expect(container.querySelector('.assistant-project-tree-row.active')).toBeNull()
  expect(selected()).toHaveLength(1)
  expect(selected()[0].closest('.assistant-project-tree-chats')).not.toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Forest' }))
  expect(projectRows()).toHaveLength(0)
  expect(selected()).toHaveLength(1)
  expect(selected()[0].closest('.assistant-chat-section')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Forest' }))
  expect(selected()).toHaveLength(1)
  expect(selected()[0].closest('.assistant-project-tree-chats')).not.toBeNull()

  await act(async () => { await store.openChat('p7') })
  expect(projectRows()).toHaveLength(5)
  expect(selected()).toHaveLength(1)
  expect(selected()[0].closest('.assistant-chat-section')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
  expect(projectRows()).toHaveLength(7)
  expect(selected()).toHaveLength(1)
  expect(selected()[0].closest('.assistant-project-tree-chats')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Projects' }))
  expect(selected()).toHaveLength(1)
  expect(selected()[0].closest('.assistant-chat-section')).not.toBeNull()
})


it('renders compact Markdown previews while keeping links and media inside the chat action', async () => {
  const mock = createMockValleyApi({ settings: { sidebarChronological: true } })
  const content = '**Canopy** with *moss*, `leaf` and [habitat](https://example.com).'
  mock.chatThreads.set('canopy', { ...thread('canopy', 'Canopy report'), messages: [{ role: 'assistant', content }] })
  mock.api.backend.call = vi.fn(async () => []) as typeof mock.api.backend.call
  const markdown = vi.spyOn(mock.api.markdown, 'render').mockResolvedValue('<p><strong>Canopy</strong> with <em>moss</em>, <code>leaf</code> and <a href="https://example.com">habitat</a>.</p><img src="https://example.com/image.png" alt="Fern"><button>Copy</button>')
  initRuntime(mock.api)
  const store = getStore(mock.api)
  const open = vi.spyOn(store, 'openChat')
  const view = render(<Panel />)
  await waitFor(() => expect(view.container.querySelector('.assistant-thread-preview strong')).toHaveTextContent('Canopy'))
  const preview = view.container.querySelector('.assistant-thread-preview')!
  expect(preview.querySelector('em')).toHaveTextContent('moss')
  expect(preview.querySelector('code')).toHaveTextContent('leaf')
  expect(preview).toHaveTextContent('habitat. Fern')
  expect(preview.querySelector('a, img, button, p')).toBeNull()
  expect(preview).not.toHaveTextContent('Copy')
  expect(markdown).toHaveBeenCalledWith(content, { breaks: true })
  fireEvent.click(preview.querySelector('em')!)
  await waitFor(() => expect(open).toHaveBeenCalledWith('canopy'))
})


it('collapses and reopens Recents without opening a different chat', async () => {
  const mock = await mountPanel({})
  const open = vi.spyOn(getStore(mock.api), 'openChat')
  const toggle = screen.getByRole('button', { name: 'Recents' })
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByText('Local note')).toBeNull()
  expect(screen.getByRole('button', { name: 'Projects' })).toBeVisible()
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('Local note')).toBeVisible()
  expect(open).not.toHaveBeenCalled()
})


it('keeps sources strictly separate even when selecting the current source again', async () => {
  await mountPanel({ showWhatsApp: false })
  expect(screen.queryByRole('button', { name: 'WhatsApp' })).toBeNull()
  const telegram = screen.getByRole('button', { name: 'Telegram' })
  await act(async () => { fireEvent.click(telegram) })
  expect(telegram).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByText('Local note')).toBeNull()
  expect(screen.getByText('Field notes')).toBeVisible()
  await act(async () => { fireEvent.click(telegram) })
  expect(telegram).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByText('Local note')).toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Chat' })) })
  expect(screen.getByText('Local note')).toBeVisible()
  expect(screen.queryByText('Field notes')).toBeNull()
})


it.each(['Telegram', 'WhatsApp'])('gives %s a chat-only view without a connection overview', async name => {
  await mountPanel({})
  expect(screen.getByRole('button', { name: 'Projects' })).toBeVisible()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })) })
  expect(screen.queryByRole('button', { name: 'Projects' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'New project' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByRole('button', { name: 'Connection settings' })).toBeVisible()
  expect(screen.queryByText('Local note')).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: 'Search chats' }), { target: { value: 'Absent fern' } })
  expect(screen.getByText('No matching chats')).toBeVisible()
})


it.each(['telegram', 'whatsapp'] as const)('renders %s as a read-only mirror with per-chat connection status', async source => {
  const mock = createMockValleyApi({ channels: [{ id: source, type: source, name: 'Canopy', displayName: 'Canopy', configured: true, running: true, connected: true }] })
  mock.chatThreads.set('remote', thread('remote', 'Canopy survey', source))
  initRuntime(mock.api)
  const store = getStore(mock.api)
  await store.openChat('remote')
  const { container } = render(<Page navigation={{ setController: vi.fn() }} />)
  await waitFor(() => expect(screen.getByRole('status', { name: 'Connected' })).toBeTruthy())
  expect(container.querySelector('textarea')).toBeNull()
  expect(container.querySelector('.assistant-send-round')).toBeNull()
  expect(container.querySelector('.assistant-channel-banner')).toHaveTextContent(`Read-only mirror · Reply in ${source === 'telegram' ? 'Telegram' : 'WhatsApp'}.`)
  expect(container.querySelector('.assistant-page-source-icon')).toBeTruthy()
  expect(mock.driverCalls.filter(call => call.driver === 'channels' && call.method === 'send')).toHaveLength(0)
})


it('does not show a green connection dot just because a transport is running', async () => {
  const mock = createMockValleyApi({ channels: [{ id: 'telegram', type: 'telegram', name: 'Canopy', displayName: 'Canopy', configured: true, running: true }] })
  mock.chatThreads.set('remote', thread('remote', 'Canopy survey', 'telegram'))
  initRuntime(mock.api)
  const store = getStore(mock.api)
  await store.openChat('remote')
  const { container } = render(<Page navigation={{ setController: vi.fn() }} />)
  await waitFor(() => expect(mock.driverCalls.some(call => call.driver === 'channels' && call.method === 'list')).toBe(true))
  expect(container.querySelector('.assistant-connection-indicator.is-connected')).toBeNull()
  expect(screen.queryByRole('status', { name: 'Connected' })).toBeNull()
})


it.each(['Telegram', 'WhatsApp'])('keeps %s compact without Recents and preserves date grouping and last-chat time', async name => {
  const mock = await mountPanel({})
  const updatedAt = new Date(2025, 0, 2, 15, 4).getTime()
  const id = name === 'Telegram' ? 't1' : 'w1'
  mock.chatThreads.get(id)!.updatedAt = updatedAt
  act(() => mock.emitState({ dateFormat: 'dd.mm.yyyy', timeFormat: '24h' }))
  await act(async () => { await getStore(mock.api).reloadThreads(); fireEvent.click(screen.getByRole('button', { name })) })
  expect(screen.queryByRole('button', { name: 'Recents' })).toBeNull()
  expect(document.querySelector('.assistant-channel-scroll')).toBeTruthy()
  expect(document.querySelector('.assistant-thread-time')).toHaveTextContent('02.01.2025 · 15:04')
  act(() => mock.emitState({ dateFormat: 'mm/dd/yyyy', timeFormat: '12h' }))
  expect(document.querySelector('.assistant-thread-time')).toHaveTextContent('01/02/2025 · 3:04 PM')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sort by time' })) })
  expect(screen.getByRole('button', { name: 'Sort by time' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('heading', { name: 'Older' })).toBeVisible()
  expect(document.querySelector('.assistant-thread-time')).toHaveTextContent('01/02/2025 · 3:04 PM')
})


it.each(['Telegram', 'WhatsApp'])('renames only the %s chat title while preserving its identity and last-chat time', async source => {
  const mock = await mountPanel({})
  const id = source === 'Telegram' ? 't1' : 'w1'
  const original = mock.chatThreads.get(id)!
  fireEvent.click(screen.getByRole('button', { name: source }))
  const timestamp = document.querySelector('.assistant-thread-time')?.textContent
  fireEvent.click(screen.getByRole('button', { name: `Chat actions: ${original.title}` }))
  const menu = vi.mocked(mock.api.ui.openMenu).mock.calls.at(-1)![0] as Array<{ label?: string; onSelect?: () => void }>
  act(() => menu.find(item => item.label === 'Rename')?.onSelect?.())
  const input = screen.getByRole('textbox', { name: 'Rename' })
  fireEvent.change(input, { target: { value: 'Field assistant' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(screen.getByText('Field assistant')).toBeVisible())
  expect(document.querySelector('.assistant-channel-identity')).toHaveTextContent(`${source.toLowerCase()} bot · Fern`)
  expect(document.querySelector('.assistant-thread-time')?.textContent).toBe(timestamp)
  expect(mock.chatThreads.get(id)).toMatchObject({ title: 'Field assistant', channelIdentity: original.channelIdentity, updatedAt: original.updatedAt })
  expect(mock.chatThreads.get(id === 't1' ? 'w1' : 't1')?.title).not.toBe('Field assistant')
})


it.each(['Telegram', 'WhatsApp'])('shows today’s full date and time instead of the %s row icon', async source => {
  const mock = await mountPanel({})
  const id = source === 'Telegram' ? 't1' : 'w1'
  mock.chatThreads.get(id)!.updatedAt = Date.now()
  await act(async () => { await getStore(mock.api).reloadThreads(); fireEvent.click(screen.getByRole('button', { name: source })) })
  const line = document.querySelector('.assistant-channel-row .assistant-thread-line')!
  const timestamp = line.querySelector('time')!
  expect(timestamp.textContent).toBe(timestamp.title)
  expect(timestamp.textContent).toContain(' · ')
  expect(line.querySelector('svg')).toBeNull()
  expect(document.querySelector('.assistant-channel-meta time')).toBeNull()
})


it('keeps Chat and ordered icons on one header row above persistent search and a new-chat action', async () => {
  const mock = await mountPanel({})
  const header = document.querySelector('.assistant-panel-head')!
  expect(header).toHaveTextContent('Chat')
  expect(header.querySelectorAll('button')).toHaveLength(4)
  expect(document.querySelectorAll('.assistant-sidebar-toolbar')).toHaveLength(1)
  const controls = Array.from(document.querySelectorAll('.assistant-source-filters button'))
  expect(controls.map(button => button.getAttribute('aria-label'))).toEqual(['Telegram', 'WhatsApp', 'Chat', 'Sort by time'])
  expect(controls.every(button => !button.textContent)).toBe(true)
  const input = screen.getByRole('textbox', { name: 'Search chats' })
  fireEvent.change(input, { target: { value: 'Absent fern' } })
  expect(screen.getByText('No matching chats')).toBeVisible()
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(screen.getByText('Local note')).toBeVisible()
  const create = vi.spyOn(getStore(mock.api), 'newChat')
  fireEvent.click(screen.getAllByRole('button', { name: 'New chat' })[0])
  expect(create).toHaveBeenCalledOnce()
})

it('remembers time mode independently for each source without combining their chats', async () => {
  await mountPanel({})
  const time = screen.getByRole('button', { name: 'Sort by time' })
  await act(async () => { fireEvent.click(time) })
  expect(time).toHaveAttribute('aria-pressed', 'true')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Telegram' })) })
  expect(time).toHaveAttribute('aria-pressed', 'false')
  await act(async () => { fireEvent.click(time) })
  expect(screen.getByText('Field notes')).toBeVisible()
  expect(screen.queryByText('Local note')).toBeNull()
  expect(screen.queryByText('Survey log')).toBeNull()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'WhatsApp' })) })
  expect(time).toHaveAttribute('aria-pressed', 'false')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Telegram' })) })
  expect(time).toHaveAttribute('aria-pressed', 'true')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Chat' })) })
  expect(time).toHaveAttribute('aria-pressed', 'true')
})

it.each(['Telegram', 'WhatsApp'])('opens the selected %s connection settings from the search row', async source => {
  const mock = await mountPanel({})
  const open = vi.spyOn(mock.api.workspace, 'openSettings')
  fireEvent.change(screen.getByRole('textbox', { name: 'Search chats' }), { target: { value: 'Local' } })
  fireEvent.click(screen.getByRole('button', { name: source }))
  expect(screen.getByRole('textbox', { name: 'Search chats' })).toHaveValue('')
  expect(document.querySelector('.assistant-panel-head')).toHaveTextContent('Chat')
  fireEvent.click(screen.getByRole('button', { name: 'Connection settings' }))
  expect(open).toHaveBeenCalledWith(`plugin:assistant#${source.toLowerCase()}`)
})


it('offers matching compose actions for Recents and the search row without saving drafts', async () => {
  const mock = await mountPanel({})
  const store = getStore(mock.api), create = vi.spyOn(store, 'newChat')
  const buttons = screen.getAllByRole('button', { name: 'New chat' })
  expect(buttons).toHaveLength(2)
  expect(buttons[0].querySelector('svg')?.innerHTML).toBe(buttons[1].querySelector('svg')?.innerHTML)
  const count = mock.chatThreads.size
  for (const button of buttons) await act(async () => { fireEvent.click(button) })
  expect(create).toHaveBeenNthCalledWith(1, undefined)
  expect(create).toHaveBeenNthCalledWith(2, undefined)
  expect(mock.chatThreads.size).toBe(count)
})

it('shows visible icons for both cancel and deletion in the confirmation menu', async () => {
  const mock = await mountPanel({})
  fireEvent.click(screen.getByRole('button', { name: 'Chat actions: Local note' }))
  const items = vi.mocked(mock.api.ui.openMenu).mock.calls.at(-1)![0] as Array<{ danger?: boolean; onSelect?(): void }>
  await act(async () => { await items.find(item => item.danger)?.onSelect?.() })
  const confirm = vi.mocked(mock.api.ui.openMenu).mock.calls.at(-1)![0] as Array<{ icon?: unknown }>
  expect(confirm).toHaveLength(2)
  expect(confirm.every(item => Boolean(item.icon))).toBe(true)
})
