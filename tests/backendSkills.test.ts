// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginBackendApi } from '@valley/plugin-sdk'
const guard = vi.hoisted(() => vi.fn())
vi.mock('../src/backend/guards', () => ({ guardFilePath: guard }))
import { datasetFixture } from './backendDatasetFixture'
import { backendApi, initBackend } from '../src/backend/runtime'
import { runSkill } from '../src/backend/skills'

const resolve = vi.fn(), run = vi.fn(), cancel = vi.fn(), openVault = vi.fn(), release = vi.fn(), off = vi.fn()
let output: Parameters<PluginBackendApi['native']['onOutput']>[0]
beforeEach(() => {
  vi.clearAllMocks()
  guard.mockResolvedValue(undefined)
  resolve.mockResolvedValue({ handle: 'approved-executable' })
  openVault.mockResolvedValue({ handle: 'approved-file', name: 'report.pdf', size: 5 })
  release.mockResolvedValue(undefined)
  cancel.mockResolvedValue(true)
  run.mockImplementation(async ({ jobId }) => { output({ jobId, stream: 'stdout', base64: Buffer.from('Grüsse').toString('base64') }); return { exitCode: 0, outputs: [] } })
  initBackend({ data: datasetFixture(), native: { resolve, run, cancel, onOutput: (callback: typeof output) => { output = callback; return off } }, files: { openVault, release } } as unknown as PluginBackendApi)
})

describe('Assistant-owned native skill runner', () => {
  it('rejects unknown runnables and missing inputs before requesting privileges', async () => {
    await expect(runSkill('/vault', 'rm', { path: 'x' })).rejects.toThrow('Unknown runnable')
    await expect(runSkill('/vault', 'markitdown', {})).rejects.toThrow('requires a file path')
    expect(resolve).not.toHaveBeenCalled()
    expect(openVault).not.toHaveBeenCalled()
  })
  it('checks the file policy and passes only approved handles to native execution', async () => {
    const path = 'Reports/a; $(touch unwanted).pdf'
    expect(await runSkill('/vault', 'markitdown', { path })).toBe('Grüsse')
    expect(guard).toHaveBeenCalledWith('/vault', path, 'read', backendApi())
    expect(openVault).toHaveBeenCalledWith(path)
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ executable: 'approved-executable', args: [{ input: 'approved-file' }] }))
    expect(release).toHaveBeenCalledWith(['approved-file'])
    expect(off).toHaveBeenCalledOnce()
  })
  it('caps output, cancels the job, and releases handles on cancellation', async () => {
    run.mockImplementation(async ({ jobId }) => { output({ jobId, stream: 'stdout', base64: btoa('x'.repeat(200_001)) }); throw new Error('Native process cancelled') })
    expect((await runSkill('/vault', 'markitdown', { path: 'report.pdf' })).length).toBe(200_000)
    expect(cancel).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledWith(['approved-file'])
    expect(off).toHaveBeenCalledOnce()
  })
  it('propagates denied permission without running or opening the input', async () => {
    resolve.mockRejectedValue(new Error('Denied'))
    await expect(runSkill('/vault', 'markitdown', { path: 'report.pdf' })).rejects.toThrow('Denied')
    expect(run).not.toHaveBeenCalled()
    expect(openVault).not.toHaveBeenCalled()
  })
})
