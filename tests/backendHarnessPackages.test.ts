// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
import { readHarnessPackage, reloadHarnessPackages, writeHarnessFile } from '../src/backend/harness/packages'
import Ajv from 'ajv'
import { assistantResults } from '../src/commandResults'

const fixture = vi.hoisted(() => ({ settings: '{}', writes: [] as string[] }))
vi.mock('../src/backend/filesystem', () => ({
  readFile: async (file: string) => { if (file.endsWith('evaluation-settings.json')) return fixture.settings; throw new Error('Not found') },
  readdir: async () => [],
  atomicWriteFile: async (file: string, content: string) => { fixture.writes.push(file); fixture.settings = content },
  queueFileWrite: (_file: string, run: () => unknown) => run()
}))
vi.mock('../src/backend/compiler', () => ({ compileUserModule: async () => ({ url: 'blob:fixture', sourceDigest: 'digest', dispose() {} }) }))
vi.mock('../src/backend/harness/workerRuntime', () => ({ createHarnessWorker: () => {
  const worker = Object.assign(new EventTarget(), { terminate() {} })
  queueMicrotask(() => worker.dispatchEvent(new MessageEvent('message', { data: { type: 'validated', cases: [{ id: 'case', name: 'Case', weight: 1 }] } })))
  return worker
} }))

beforeEach(() => {
  fixture.settings = '{}'; fixture.writes.length = 0
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ fixture: {
    manifest: { apiVersion: 1, id: 'fixture', name: 'Fixture', version: '1', description: '', enabled: true },
    config: { packageKind: 'ai-harness', main: 'src/harness.ts', icon: 'box', settingsSchema: [], execution: { timeoutMs: 1000, memoryMb: 32, maxResponseBytes: 65536, maxTurns: 2, maxConcurrency: 2 }, retry: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10 }, cache: { maxAgeDays: 1, maxSizeMb: 1 } },
    files: { 'src/harness.ts': 'export function register() {}' }
  } })))
})

it('loads built-in source from its package without seeding files', async () => {
  expect(await reloadHarnessPackages('/vault')).toMatchObject([{ id: 'fixture', ready: true }])
  const snapshot = await readHarnessPackage('/vault', 'fixture')
  expect(snapshot).toMatchObject({ readOnly: true, files: expect.arrayContaining([expect.objectContaining({ path: 'src/harness.ts' })]) })
  const validator = new Ajv({ strict: false })
  expect(validator.validate(assistantResults['harness-inspect'], { package: snapshot, runs: [] }), JSON.stringify(validator.errors)).toBe(true)
  expect(fixture.writes).toEqual([])
})

it('stores a built-in enabled toggle as settings and preserves source', async () => {
  await reloadHarnessPackages('/vault')
  const snapshot = (await readHarnessPackage('/vault', 'fixture'))!
  const baseline = snapshot.files.find((file) => file.path === 'manifest.json')!.baseline
  expect(await writeHarnessFile('/vault', 'fixture', 'manifest.json', JSON.stringify({ ...snapshot.manifest, enabled: false }), baseline)).toMatchObject({ ok: true })
  expect(fixture.writes).toEqual(['/vault/.valley/plugins/data/assistant/evaluation-settings.json'])
  expect(JSON.parse(fixture.settings)).toEqual({ __enabled: { fixture: false } })
  expect(await reloadHarnessPackages('/vault')).toMatchObject([{ id: 'fixture', ready: false, enabled: false }])
  expect((await readHarnessPackage('/vault', 'fixture'))?.manifest.enabled).toBe(false)
  expect(await writeHarnessFile('/vault', 'fixture', 'manifest.json', JSON.stringify(snapshot.manifest), baseline)).toMatchObject({ ok: false, reason: 'conflict' })
})

it('rejects built-in source and identity changes', async () => {
  await reloadHarnessPackages('/vault')
  const snapshot = (await readHarnessPackage('/vault', 'fixture'))!
  expect(await writeHarnessFile('/vault', 'fixture', 'src/harness.ts', '', snapshot.files[0].baseline)).toMatchObject({ ok: false })
  expect(await writeHarnessFile('/vault', 'fixture', 'manifest.json', JSON.stringify({ ...snapshot.manifest, name: 'Replacement' }), snapshot.files.find((file) => file.path === 'manifest.json')!.baseline)).toMatchObject({ ok: false })
  expect(fixture.writes).toEqual([])
})
