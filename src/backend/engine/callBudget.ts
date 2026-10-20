import type { AiToolCall } from '../../types'

// Calls the model cannot fix by changing its input: repeating them only burns the turn.
const unsupported = new Set(['UNKNOWN_TOOL', 'PLAN_REQUIRES_APPROVAL', 'PLAN_MODE_DENIED', 'GUARD_DENIED', 'APPROVAL_REJECTED'])
const unsupportedMessage = /PLAN_MODE_DENIED|Command is unavailable|is unavailable in this|not supported/i
export const callBudgetLimits = { unsupported: 3, identical: 3, corrections: 6 }

// Bounds repeated unsupported calls and correction loops per turn. Legitimate corrections (new input after an input or
// conflict error) keep going up to a larger bound; an unchanged call that fails the same way stops sooner.
export function callBudget(limits = callBudgetLimits) {
  const unsupportedCount = new Map<string, number>(), identical = new Map<string, number>(), corrections = new Map<string, number>()
  return {
    record(call: Pick<AiToolCall, 'name' | 'arguments'>, failure?: { code: string; message: string }): string | undefined {
      const args = (call.arguments ?? {}) as Record<string, unknown>
      const target = typeof args.command === 'string' ? `${call.name} ${args.command}` : call.name
      if (!failure) { corrections.delete(target); return undefined }
      const signature = `${call.name}:${JSON.stringify(args)}:${failure.code}:${failure.message}`
      if (unsupported.has(failure.code) || unsupportedMessage.test(failure.message)) {
        const count = (unsupportedCount.get(target) ?? 0) + 1
        unsupportedCount.set(target, count)
        if (count >= limits.unsupported) return `Stopped: ${target} is not available here and was tried ${count} times. Nothing more was run.`
      }
      const same = (identical.get(signature) ?? 0) + 1
      identical.set(signature, same)
      if (same >= limits.identical) return `Stopped: ${target} failed the same way ${same} times with the same input. Nothing more was run.`
      const tries = (corrections.get(target) ?? 0) + 1
      corrections.set(target, tries)
      if (tries >= limits.corrections) return `Stopped: ${target} still failed after ${tries} corrections in a row. Nothing more was run.`
      return undefined
    }
  }
}
