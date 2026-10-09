import type { AiChatThread, AiMessage, InboundAttachment } from '../types'
import type { ContextUsage } from './context'

export const sessionStates = ['IDLE', 'QUEUED', 'PREPARING', 'INFERRING', 'AWAITING_TOOLS', 'AWAITING_APPROVAL', 'EXECUTING_TOOLS', 'AWAITING_QUESTION', 'COMPACTING', 'INTERRUPTED', 'FAILED'] as const
export type SessionState = typeof sessionStates[number]
export interface QueuedTurn {
  admissionPending?: boolean
  targetReference?: string
  inputFingerprint?: string
  questionId?: string
  channelActor?: { senderId: string; topicId?: string; chatType?: import('./channel').MessageDestination['chatType'] }
  callbackData?: string
  origin?: 'voice'
  id: string
  conversationId: string
  text: string
  attachments: InboundAttachment[]
  createdAt: number
  priority: number
  editing: boolean
}
export interface SessionSnapshot {
  currentTurn?: QueuedTurn
  conversationId: string
  revision: number
  state: SessionState
  runId: string | null
  streamingText: string
  queue: QueuedTurn[]
  paused: boolean
  error: string | null
  context: ContextUsage | null
  thread?: AiChatThread
}
export interface SessionEvent {
  id: string
  conversationId: string
  revision: number
  type: string
  createdAt: number
  payload: unknown
}
export interface TurnSubmission {
  admissionPending?: boolean
  targetReference?: string
  inputFingerprint?: string
  questionId?: string
  channelActor?: { senderId: string; topicId?: string; chatType?: import('./channel').MessageDestination['chatType'] }
  callbackData?: string
  origin?: 'voice'
  id: string
  conversationId: string
  text: string
  attachments?: InboundAttachment[]
  thread?: AiChatThread
}
export interface TranscriptEvent {
  id: string
  conversationId: string
  message: AiMessage
}
