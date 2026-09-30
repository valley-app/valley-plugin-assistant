import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { HarnessPackageStatus } from '../src/harnessTypes'
import { AiHarnessesSection } from '../src/HarnessSettings'
import { initRuntime } from '../src/runtime'
import { initLocalization } from '../src/localization'
import { createMockValleyApi } from './mock'

const status: HarnessPackageStatus = {
  id: 'community-eval',
  name: 'Community Eval',
  version: '1.2.3',
  description: 'Fixture',
  enabled: true,
  icon: 'box',
  ready: true,
  caseCount: 4,
  settingsSchema: [],
  settings: {},
  execution: { timeoutMs: 1000, memoryMb: 32, maxResponseBytes: 65536, maxTurns: 2, maxConcurrency: 2 }
}

const callBackend = vi.fn()
let readOnly = false
const onDriverEvent = vi.fn(() => () => {})

beforeEach(() => {
  callBackend.mockReset()
  onDriverEvent.mockClear()
  callBackend.mockImplementation(async (raw: string) => {
    const method = raw.replace(/^ai\./, '')
    if (method === 'listHarnesses') return { harnesses: [status] }
    if (method === 'readHarnessPackage') return { package: { manifest: { id: status.id, enabled: true }, config: { main: 'src/harness.ts' }, readOnly, files: [{ path: 'src/harness.ts', content: 'export function register() {}', baseline: { hash: 'baseline', mtimeMs: 0, size: 1 } }, { path: 'manifest.json', content: '{}', baseline: { hash: 'manifest', mtimeMs: 0, size: 2 } }] } }
    if (method === 'listConnections') return { connections: [] }
    if (method === 'listHarnessRuns') return { runs: [] }
    return { ok: true, baseline: { hash: 'updated', mtimeMs: 1, size: 1 } }
  })
  readOnly = false
  const { api } = createMockValleyApi()
  api.backend.call = callBackend
  api.backend.on = onDriverEvent
  initRuntime(api)
  initLocalization(api)
})

afterEach(cleanup)

describe('Assistant settings → Harnesses', () => {
  it('uses the shared Accounts-style list and dynamic package identity', async () => {
    render(<AiHarnessesSection />)
    expect(await screen.findByText('Community Eval')).toBeTruthy()
    expect(document.querySelector('.settings-listpage-header')).toBeTruthy()
    expect(document.querySelector('.settings-list-row')).toBeTruthy()
    expect(screen.getByText('4 cases · v1.2.3')).toBeTruthy()
  })

  it('opens a breadcrumb detail page without harness-specific UI branches', async () => {
    render(<AiHarnessesSection />)
    fireEvent.click(await screen.findByText('Community Eval'))
    await waitFor(() => expect(callBackend).toHaveBeenCalledWith('ai.readHarnessPackage', { id: 'community-eval' }))
    expect(document.querySelector('.settings-listpage-crumbs')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Back to evaluations' })).toBeTruthy()
  })

  it('keeps bundled source read-only while allowing its enabled state to change', async () => {
    readOnly = true
    render(<AiHarnessesSection />)
    fireEvent.click(await screen.findByText('Community Eval'))
    const editor = await screen.findByRole('textbox', { name: /src\/harness.ts/ })
    expect((editor as HTMLTextAreaElement).readOnly).toBe(true)
    expect((screen.getByRole('button', { name: 'Save source' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getAllByRole('switch')[0])
    await waitFor(() => expect(callBackend).toHaveBeenCalledWith('ai.updateHarnessManifest', expect.objectContaining({ id: status.id, manifest: { id: status.id, enabled: false }, baseline: expect.objectContaining({ hash: 'manifest' }) })))
  })

  it('preserves the file baseline when saving custom source', async () => {
    render(<AiHarnessesSection />)
    fireEvent.click(await screen.findByText('Community Eval'))
    const editor = await screen.findByRole('textbox', { name: /src\/harness.ts/ })
    fireEvent.change(editor, { target: { value: 'export const changed = true' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save source' }))
    await waitFor(() => expect(callBackend).toHaveBeenCalledWith('ai.writeHarnessFile', expect.objectContaining({ content: 'export const changed = true', baseline: expect.objectContaining({ hash: 'baseline' }) })))
  })

  it('preserves unsaved evaluation source when another file is selected', async () => {
    render(<AiHarnessesSection />)
    fireEvent.click(await screen.findByText('Community Eval'))
    const editor = await screen.findByRole('textbox', { name: /src\/harness.ts/ })
    fireEvent.change(editor, { target: { value: 'export const moss = true' } })
    fireEvent.click(screen.getByRole('button', { name: 'manifest.json' }))
    expect(editor).toHaveValue('export const moss = true')
    expect(screen.getByText('Save your source changes before switching files or reloading.')).toBeVisible()
  })

})
