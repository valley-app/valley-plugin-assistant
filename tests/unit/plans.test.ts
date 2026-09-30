import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiChatThread } from '../../src/types'
import { datasetFixture } from '../backendDatasetFixture'
import { AssistantRepository, record } from '../../src/backend/persistence/repositories'
const state = vi.hoisted(() => ({ files: new Map<string, string>(), hash: 'a'.repeat(64), retained: false, channel: 'notes/channel.md', compile: vi.fn(), write: vi.fn() }))
vi.mock('../../src/backend/filesystem', () => ({ readFile: async (file: string) => { if (!state.files.has(file)) throw new Error('Missing artifact'); return state.files.get(file)! } }))
vi.mock('../../src/backend/runtime', () => ({ VAULT_ROOT: '/vault', backendApi: () => ({ agent: { writePlan: state.write } }) }))
vi.mock('../../src/backend/configuration/instructions', () => ({ compileInstructions: state.compile }))
vi.mock('../../src/backend/configuration/settings', () => ({ configurationDiagnostics: () => [] }))
vi.mock('../../src/backend/channels/manager', () => ({ channelManager: { list: async () => [{ id: 'telegram-fern', instructionsPath: state.channel }] } }))
import { PlanService, planHash, type PlanFiles } from '../../src/backend/plans'
const files: PlanFiles = { 'plan.md': '# Inspect the fern collection', 'tasks.md': '- [ ] Count specimens', 'acceptance.md': '- No originals changed', 'decisions.md': '- Use the existing catalog' }
const bundle = () => ({ hash: state.hash, retained: state.retained, sources: [], text: 'Instructions', scope: 'scope', bytes: 12 })
beforeEach(() => {
  state.files.clear(); state.hash = 'a'.repeat(64); state.retained = false; state.channel = 'notes/channel.md'
  state.compile.mockReset().mockImplementation(async () => bundle())
  state.write.mockReset().mockImplementation(async (_scope: string, content: PlanFiles) => {
    const directory = '.valley/plugins/data/assistant/plans/fern/revisions/1'
    for (const [name, text] of Object.entries(content)) state.files.set(`/vault/${directory}/${name}`, text)
    return { directory, hash: planHash(content) }
  })
})
async function setup() {
  const repository = new AssistantRepository(datasetFixture()), service = new PlanService(repository)
  const thread: AiChatThread = { id: 'fern', title: 'Fern catalog', mode: 'plan', source: 'telegram', channelId: 'telegram-fern', createdAt: 1, updatedAt: 1, messages: [] }
  const plan = await service.present(thread, 'scope', '00000000-0000-4000-8000-000000000001', 1, files, state.hash, { conversationId: thread.id, mode: 'plan', context: 'VAULT', voice: true, channelInstruction: state.channel })
  thread.plan = { ...plan, text: files['plan.md'] }
  const expected = { planId: plan.id, revision: plan.revision, artifactHash: plan.artifactHash, instructionSnapshotId: plan.instructionSnapshotId }
  return { repository, service, thread, plan, expected }
}
describe('immutable plan approval', () => {
  it('never reuses a reserved revision after an interrupted artifact write', async () => {
    const { service, thread, plan } = await setup()
    expect(await service.reserveRevision(thread, plan.id)).toBe(2)
    expect(await service.reserveRevision(thread, plan.id)).toBe(3)
  })

  it('binds every artifact and recompiles the same voice guidance with current channel links', async () => {
    const { service, thread, expected } = await setup()
    await expect(service.validate(thread, expected)).resolves.toMatchObject({ artifactHash: planHash(files) })
    expect(state.compile).toHaveBeenLastCalledWith('/vault', expect.objectContaining({ mode: 'plan', voice: true, channelInstruction: 'notes/channel.md' }))
    state.channel = 'notes/new-channel.md'
    await service.validate(thread, expected)
    expect(state.compile).toHaveBeenLastCalledWith('/vault', expect.objectContaining({ channelInstruction: 'notes/new-channel.md' }))
  })
  it.each(['plan.md', 'tasks.md', 'acceptance.md', 'decisions.md'] as const)('invalidates approval when %s changes', async name => {
    const { service, thread, plan, expected } = await setup()
    state.files.set(`/vault/${plan.directory}/${name}`, 'Changed content')
    await expect(service.validate(thread, expected)).rejects.toThrow('files changed')
  })
  it('rejects cross-conversation, stale revision, changed and retained instruction snapshots', async () => {
    const { service, thread, expected } = await setup()
    await expect(service.validate({ ...thread, id: 'moss' }, expected)).rejects.toThrow('no longer awaiting')
    await expect(service.validate(thread, { ...expected, revision: 2 })).rejects.toThrow('no longer awaiting')
    state.hash = 'b'.repeat(64)
    await expect(service.validate(thread, expected)).rejects.toThrow('Instructions changed')
    state.hash = expected.instructionSnapshotId; state.retained = true
    await expect(service.validate(thread, expected)).rejects.toThrow('Instructions changed')
  })
  it('rechecks approval at implementation admission and after a queued configuration change', async () => {
    const { repository, service, thread, plan, expected } = await setup(), key = `${plan.id}:1`
    await repository.data.transaction([{ dataset: 'plans', operation: 'upsert', values: record(key, thread.id, 'APPROVED', { ...plan, status: 'approved' }) }, { dataset: 'plan_approvals', operation: 'insert', values: record(key, thread.id, 'APPROVED', expected) }])
    thread.mode = 'execute'; thread.plan!.status = 'approved'
    await expect(service.verifyApproved(thread, `approval:${key}`)).resolves.toBeUndefined()
    state.hash = 'b'.repeat(64)
    await expect(service.verifyApproved(thread, `approval:${key}`)).rejects.toThrow('Instructions changed')
  })
})
