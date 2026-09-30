export interface ContextUsage {
  inputTokens: number
  capacity: number | null
  reservedTokens: number | null
  availableTokens: number | null
  usedFraction: number | null
  estimated: boolean
  model: string
  compacting: boolean
}
export interface ContextCheckpoint {
  id: string
  conversationId: string
  throughMessageId: string
  messageCount: number
  summary: string
  createdAt: number
}
