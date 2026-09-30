import * as React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProjectMode, projectSelection } from '../src/ProjectMode'
import { ProjectsPane } from '../src/Settings'
import { initRuntime } from '../src/runtime'
import { initLocalization } from '../src/localization'
import { createMockValleyApi } from './mock'

afterEach(() => { cleanup(); projectSelection.select() })
it('refreshes project choices when another surface selects a newly created project', async () => {
  const { api } = createMockValleyApi()
  const project = { id: 'new-project', name: 'Meadow code', instructions: '', folders: [], createdAt: 1, updatedAt: 1 }
  let projects: typeof project[] = []
  const call = vi.fn(async (_method, { method }) => method === 'list' ? projects : { project, roots: [] })
  api.backend.call = call as typeof api.backend.call
  initRuntime(api); initLocalization(api)
  const props = { chats: [], busy: false, onSelect: async () => {}, onNewChat: () => {}, onOpen: () => {} }
  const { rerender } = render(<ProjectMode {...props} />)
  await waitFor(() => expect(call).toHaveBeenCalledOnce())
  projects = [project]
  rerender(<ProjectMode {...props} projectId={project.id} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Meadow code' })).toBeTruthy())
})

it('cancels a project draft with Escape without creating it', async () => {
  const { api } = createMockValleyApi()
  const call = vi.fn(async () => [])
  api.backend.call = call as typeof api.backend.call
  initRuntime(api); initLocalization(api)
  render(<ProjectMode chats={[]} busy={false} onSelect={async () => {}} onNewChat={() => {}} onOpen={() => {}} />)
  await waitFor(() => expect(call).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: 'New project' }))
  const input = screen.getByRole('textbox', { name: 'Project name' })
  fireEvent.change(input, { target: { value: 'Meadow survey' } })
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(screen.queryByRole('textbox', { name: 'Project name' })).toBeNull()
  expect(call).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'New project' }))
  expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue('')
})

it('expands a project without creating a chat and exposes folders only through settings', async () => {
  const { api } = createMockValleyApi()
  const project = { id: 'forest', name: 'Forest', instructions: 'Observe moss.', folders: [], createdAt: 1, updatedAt: 1 }
  api.backend.call = vi.fn(async (operation, { method }) => operation === 'configuration.status' ? { notes: [{ id: 'project', group: 'instructions', path: '.valley/plugins/data/assistant/config/projects/forest.md' }], diagnostics: [] } : method === 'list' ? [project] : { project, roots: [] }) as typeof api.backend.call
  initRuntime(api); initLocalization(api)
  const select = vi.fn(), newChat = vi.fn(), open = vi.fn()
  render(<ProjectMode chats={[{ id: 'canopy', title: 'Canopy report', projectId: 'forest', updatedAt: 1 }]} busy={false} onSelect={select} onNewChat={newChat} onOpen={open} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Forest' }))
  expect(select).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Canopy report' }))
  expect(open).toHaveBeenCalledWith('canopy')
  fireEvent.click(screen.getByRole('button', { name: 'New conversation: Forest' }))
  expect(newChat).toHaveBeenCalledWith('forest')
  fireEvent.click(screen.getByRole('button', { name: 'Project settings: Forest' }))
  expect(api.workspace.openSettings).toHaveBeenCalledWith('plugin:assistant#projects')
  expect(screen.queryByDisplayValue('Observe moss.')).toBeNull()
  render(<ProjectsPane />)
  expect(await screen.findByText('Project instructions')).toBeInTheDocument()
  expect(screen.queryByDisplayValue('Observe moss.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
  expect(api.workspace.openFile).toHaveBeenCalledWith('.valley/plugins/data/assistant/config/projects/forest.md')
  expect(screen.getByRole('button', { name: 'Add folder' })).toBeTruthy()
})


it('keeps project search results capped at five until Show more is clicked', async () => {
  const { api } = createMockValleyApi()
  const project = { id: 'forest', name: 'Forest', instructions: '', folders: [], createdAt: 1, updatedAt: 1 }
  api.backend.call = vi.fn(async () => [project]) as typeof api.backend.call
  initRuntime(api); initLocalization(api)
  const chats = Array.from({ length: 7 }, (_, index) => ({ id: String(index), title: `Forest report ${index}`, projectId: 'forest', updatedAt: index }))
  render(<ProjectMode projectId="forest" query="Forest" chats={chats} busy={false} onSelect={async () => {}} onNewChat={() => {}} onOpen={() => {}} />)
  await screen.findByRole('button', { name: 'Forest' })
  expect(screen.getAllByRole('button', { name: /^Forest report/ })).toHaveLength(5)
  fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
  expect(screen.getAllByRole('button', { name: /^Forest report/ })).toHaveLength(7)
})
