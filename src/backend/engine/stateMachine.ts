import type { SessionState } from '../../contracts/execution'

const transitions: Record<SessionState, readonly SessionState[]> = {
  IDLE: ['QUEUED', 'COMPACTING'],
  QUEUED: ['PREPARING', 'IDLE', 'INTERRUPTED', 'FAILED'],
  PREPARING: ['INFERRING', 'COMPACTING', 'FAILED', 'INTERRUPTED', 'IDLE'],
  INFERRING: ['AWAITING_TOOLS', 'AWAITING_QUESTION', 'COMPACTING', 'IDLE', 'FAILED', 'INTERRUPTED'],
  AWAITING_TOOLS: ['EXECUTING_TOOLS', 'AWAITING_APPROVAL', 'INFERRING', 'FAILED', 'INTERRUPTED'],
  AWAITING_APPROVAL: ['EXECUTING_TOOLS', 'INFERRING', 'FAILED', 'INTERRUPTED'],
  EXECUTING_TOOLS: ['INFERRING', 'AWAITING_QUESTION', 'AWAITING_APPROVAL', 'FAILED', 'INTERRUPTED'],
  AWAITING_QUESTION: ['INFERRING', 'EXECUTING_TOOLS', 'QUEUED', 'PREPARING', 'IDLE', 'INTERRUPTED', 'FAILED'],
  COMPACTING: ['PREPARING', 'IDLE', 'FAILED', 'INTERRUPTED'],
  INTERRUPTED: ['QUEUED', 'PREPARING', 'COMPACTING', 'IDLE'],
  FAILED: ['QUEUED', 'PREPARING', 'COMPACTING', 'IDLE', 'INTERRUPTED']
}
export function assertTransition(from: SessionState, to: SessionState): void {
  if (from !== to && !transitions[from].includes(to)) throw new Error(`Invalid session transition: ${from} → ${to}`)
}
export const isActiveState = (state: SessionState): boolean => !['IDLE', 'QUEUED', 'AWAITING_QUESTION', 'INTERRUPTED', 'FAILED'].includes(state)
