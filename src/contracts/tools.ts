import type { z } from 'zod'
import type { GuardLayers, GuardTarget } from '@valley/plugin-sdk/guard/types'
import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
import type { SessionState } from './execution'

export type ToolEffect = 'read' | 'retryable' | 'non-idempotent'
export type ToolGroup = 'general' | 'reading' | 'messaging' | 'chat' | 'telegram' | 'whatsapp'
export type ToolResult<T = unknown> = { success: true; value: T } | { success: false; error: { code: string; message: string; recoverable: boolean; outcomeUnknown?: boolean; execution?: { id: string; command: string; status: string; revision: number } } }
export interface ToolExecutionContext {
  conversationId: string
  runId: string
  planning: boolean
  guardLayers?: GuardLayers
  operation: PluginBackendOperationContext
  state(state: SessionState): Promise<void>
  approve(targets: GuardTarget[], args: unknown): Promise<boolean>
}
export interface AssistantTool<TInput = unknown, TOutput = unknown> {
  name: string
  description: string
  group: ToolGroup
  parameters: z.ZodType<TInput>
  jsonSchema?: Record<string, unknown>
  output: z.ZodType<TOutput>
  requiredCapabilities: string[]
  guardTargets(input: TInput): GuardTarget[]
  timeoutMs: number
  effect: ToolEffect
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>
}
