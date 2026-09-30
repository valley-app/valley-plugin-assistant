import type { AiMessage, AiStreamEvent, AiToolCall, AiToolDef } from './types'
import type { FileBaseline, GuardedWriteResult } from '@valley/plugin-sdk/types'

export type HarnessSettingValue = string | number | boolean | readonly string[]

export interface HarnessSettingOption {
  value: string
  label: string
}

export interface HarnessSettingField {
  key: string
  label: string
  description?: string
  type: 'text' | 'number' | 'boolean' | 'select' | 'textarea' | 'range'
  default?: HarnessSettingValue
  required?: boolean
  min?: number
  max?: number
  step?: number
  options?: readonly HarnessSettingOption[]
}

export interface HarnessManifest {
  apiVersion: 1
  id: string
  name: string
  version: string
  description: string
  author?: string
  enabled: boolean
}

export interface HarnessRetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export interface HarnessCachePolicy {
  maxAgeDays: number
  maxSizeMb: number
}

export interface HarnessExecutionLimits {
  timeoutMs: number
  memoryMb: number
  maxResponseBytes: number
  maxTurns: number
  maxConcurrency: number
}

export interface HarnessConfig {
  packageKind: 'ai-harness'
  main: string
  icon: string
  settingsSchema: readonly HarnessSettingField[]
  execution: HarnessExecutionLimits
  retry: HarnessRetryPolicy
  cache: HarnessCachePolicy
}

export interface HarnessTarget {
  provider: string
  connectionId?: string
  model: string
}

export interface HarnessCompletionRequest {
  messages: AiMessage[]
  tools?: AiToolDef[]
  temperature?: number
  maxTokens?: number
}

export interface HarnessCompletion {
  text: string
  toolCalls: AiToolCall[]
  events: AiStreamEvent[]
  usage: { inputTokens: number; outputTokens: number }
  finishReason?: string
  latencyMs: number
  cached: boolean
  retries: number
}

export interface HarnessToolHandlerContext {
  call: AiToolCall
  transcript: readonly AiMessage[]
  settings: Readonly<Record<string, HarnessSettingValue>>
}

export interface HarnessTool {
  definition: AiToolDef
  handle?: (context: HarnessToolHandlerContext) => unknown | Promise<unknown>
}

export interface HarnessThread {
  run(): Promise<HarnessCompletion>
  appendMessage(message: AiMessage): void
  appendToolResult(callId: string, result: unknown, name?: string): void
  transcript(): readonly AiMessage[]
  toolCalls(): readonly AiToolCall[]
  halted(): boolean
}

export interface HarnessAssertion {
  name: string
  passed: boolean
  message?: string
}

export interface HarnessCaseResult {
  status: 'pass' | 'fail' | 'skip' | 'error'
  score?: number
  assertions?: HarnessAssertion[]
  metrics?: Record<string, number>
  error?: { kind: string; message: string; attempts?: number }
}

export interface HarnessCaseContext {
  target: HarnessTarget
  settings: Readonly<Record<string, HarnessSettingValue>>
  cancellation: { readonly aborted: boolean; throwIfAborted(): void }
  complete(request: HarnessCompletionRequest): Promise<HarnessCompletion>
  createThread(input: Omit<HarnessCompletionRequest, 'tools'> & { tools?: readonly HarnessTool[]; autoTools?: boolean }): HarnessThread
  cache: { clear(): Promise<void> }
}

export interface HarnessCaseDefinition {
  id: string
  name: string
  description?: string
  weight?: number
  run(context: HarnessCaseContext): HarnessCaseResult | Promise<HarnessCaseResult>
}

export interface HarnessRegistration {
  id: string
  cases: readonly HarnessCaseDefinition[]
}

export interface HarnessRegisterApi {
  case(definition: HarnessCaseDefinition): HarnessCaseDefinition
}

export type HarnessRegister = (api: Readonly<HarnessRegisterApi>) => HarnessRegistration

export interface HarnessPackageFile {
  path: string
  content: string
  baseline: FileBaseline | null
}

export interface HarnessPackageStatus {
  id: string
  name: string
  version: string
  description: string
  author?: string
  enabled: boolean
  icon: string
  ready: boolean
  error?: string
  updateAvailable?: boolean
  sourceDigest?: string
  caseCount?: number
  settingsSchema: readonly HarnessSettingField[]
  settings: Record<string, HarnessSettingValue>
  execution: HarnessExecutionLimits
}

export interface HarnessPackageSnapshot {
  manifest: HarnessManifest
  config: HarnessConfig
  files: HarnessPackageFile[]
}

export interface HarnessCreatePackage {
  manifest: HarnessManifest
  config: HarnessConfig
  files: Record<string, string>
}

export interface HarnessRunOptions {
  useCache?: boolean
  concurrency?: number
}

export interface HarnessCaseRun extends Required<Omit<HarnessCaseResult, 'error'>> {
  id: string
  name: string
  weight: number
  error?: HarnessCaseResult['error']
  hostMetrics: {
    latencyMs: number
    inputTokens: number
    outputTokens: number
    costUsd: number
    retries: number
    cacheHits: number
    turnCount: number
  }
}

export interface HarnessTargetRun {
  target: HarnessTarget
  score: number
  cases: HarnessCaseRun[]
}

export interface HarnessRun {
  id: string
  harnessId: string
  harnessVersion: string
  sourceDigest: string
  startedAt: number
  completedAt?: number
  status: 'running' | 'completed' | 'cancelled' | 'error'
  options: Required<HarnessRunOptions>
  targets: HarnessTargetRun[]
  error?: string
}

export interface HarnessEvent {
  runId: string
  harnessId: string
  type: 'started' | 'target-started' | 'case-started' | 'retry' | 'case-completed' | 'target-completed' | 'completed' | 'cancelled' | 'error'
  target?: HarnessTarget
  caseId?: string
  attempt?: number
  delayMs?: number
  run?: HarnessRun
  message?: string
}

export type HarnessWriteResult = GuardedWriteResult
