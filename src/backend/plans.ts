import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { AiChatThread } from '../types'
import { AssistantRepository, record } from './persistence/repositories'
import { compileInstructions, type InstructionScope } from './configuration/instructions'
import { relativeAssistantNote } from './configuration/markdown'
import { projectConfigurationNote } from './configuration/conversations'
import { configurationDiagnostics } from './configuration/settings'
import { readFile } from './filesystem'
import { backendApi, VAULT_ROOT } from './runtime'
import { channelManager } from './channels/manager'

export type PlanFiles = Record<'plan.md' | 'tasks.md' | 'acceptance.md' | 'decisions.md', string>
export const planHash = (files: PlanFiles) => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(Object.keys(files).sort().map(name => [name, files[name as keyof PlanFiles]])))))
export interface SavedPlan {
  id: string
  conversationId: string
  revision: number
  artifactHash: string
  instructionSnapshotId: string
  instructionScope?: InstructionScope
  directory: string
  status: 'review' | 'approved' | 'changes'
  createdAt: number
}
export function instructionContext(thread: AiChatThread) {
  return { conversationId: thread.id, mode: thread.mode ?? 'execute' as const, context: thread.projectId ? 'MIXED' as const : 'VAULT' as const, profileId: thread.profileId, source: thread.source, conversationInstruction: thread.instructionsPath, projectInstruction: thread.projectId ? relativeAssistantNote(projectConfigurationNote(thread.projectId)) : undefined }
}
export class PlanService {
  constructor(private repository: AssistantRepository, private api: PluginBackendOperationContext['api'] = backendApi()) {}
  async reserveRevision(thread: AiChatThread, id: string): Promise<number> {
    const previous = await this.repository.rows<{ id: string; revision: number }>('plans', { conversationId: thread.id })
    const revision = Math.max(thread.plan?.id === id ? thread.plan.revision ?? 0 : 0, ...previous.filter(value => value.id === id).map(value => value.revision)) + 1
    await this.repository.data.transaction([{ dataset: 'plans', operation: 'insert', values: record(`${id}:${revision}`, thread.id, 'DRAFT', { id, revision, conversationId: thread.id, status: 'draft', createdAt: Date.now() }, revision) }])
    return revision
  }
  async present(thread: AiChatThread, scopeId: string, id: string, revision: number, files: PlanFiles, instructionSnapshotId: string, instructionScope?: InstructionScope): Promise<SavedPlan> {
    const output = await this.api.agent.writePlan(scopeId, files)
    if (output.hash !== planHash(files)) throw new Error('Plan artifact integrity check failed')
    const plan: SavedPlan = { id, revision, conversationId: thread.id, artifactHash: output.hash, instructionSnapshotId, instructionScope, directory: output.directory, status: 'review', createdAt: Date.now() }
    await this.repository.data.transaction([{ dataset: 'plans', operation: 'upsert', values: record(`${id}:${revision}`, thread.id, 'REVIEW', plan, revision) }])
    return plan
  }
  async validate(thread: AiChatThread, expected: { planId: string; revision: number; artifactHash: string; instructionSnapshotId: string }): Promise<SavedPlan> {
    const plan = await this.repository.get<SavedPlan>('plans', `${expected.planId}:${expected.revision}`)
    if (!plan || plan.conversationId !== thread.id || plan.status !== 'review' || thread.plan?.id !== plan.id || thread.plan.revision !== plan.revision) throw new Error('This plan revision is no longer awaiting approval')
    if (plan.artifactHash !== expected.artifactHash || plan.instructionSnapshotId !== expected.instructionSnapshotId) throw new Error('The reviewed plan has changed')
    await this.verify(thread, plan)
    return plan
  }
  async files(plan: SavedPlan): Promise<PlanFiles> {
    const files = {} as PlanFiles
    for (const name of ['plan.md', 'tasks.md', 'acceptance.md', 'decisions.md'] as const) files[name] = await readFile(`${VAULT_ROOT}/${plan.directory}/${name}`, 'utf8', this.api)
    if (planHash(files) !== plan.artifactHash) throw new Error('Plan files changed after review. Refine and review a new revision.')
    return files
  }
  async verifyApproved(thread: AiChatThread, turnId: string) {
    const key = turnId.slice('approval:'.length)
    const plan = await this.repository.get<SavedPlan>('plans', key)
    const approval = await this.repository.get<{ artifactHash: string; instructionSnapshotId: string }>('plan_approvals', key)
    if (!plan || !approval || plan.status !== 'approved' || plan.conversationId !== thread.id || thread.plan?.id !== plan.id || thread.plan.revision !== plan.revision || approval.artifactHash !== plan.artifactHash || approval.instructionSnapshotId !== plan.instructionSnapshotId) throw new Error('This implementation approval is no longer valid')
    await this.verify(thread, plan)
  }
  private async verify(thread: AiChatThread, plan: SavedPlan) {
    await this.files(plan)
    const channel = thread.channelId ? (await channelManager.list(VAULT_ROOT, this.api)).find(value => value.id === thread.channelId) : undefined
    const instructions = await compileInstructions(VAULT_ROOT, { ...plan.instructionScope, ...instructionContext(thread), mode: 'plan', channelInstruction: channel?.instructionsPath }, this.api)
    if (configurationDiagnostics().length || instructions.retained || instructions.error || instructions.hash !== plan.instructionSnapshotId) throw new Error('Instructions changed or contain errors. Refine the plan before approval.')
  }
}
