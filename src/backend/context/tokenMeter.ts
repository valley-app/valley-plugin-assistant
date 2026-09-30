import type { AiChatRequest } from '../../types'
import type { ContextUsage } from '../../contracts/context'

export function estimateTokens(request: AiChatRequest): number {
  const { messages, tools } = request
  const serialized = JSON.stringify({ tools, messages: messages.map(message => ({ ...message, attachments: message.attachments?.map(attachment => ({ mime: attachment.mime })) })) })
  const text = Math.ceil(new TextEncoder().encode(serialized).byteLength / 3)
  const media = messages.reduce((sum, message) => sum + (message.attachments?.length ?? 0) * 4096, 0)
  return text + media
}

export function contextUsage(request: AiChatRequest, capacity?: number | null, measured?: number): ContextUsage {
  const known = capacity && Number.isFinite(capacity) && capacity > 0 ? capacity : null
  const inputTokens = measured ?? estimateTokens(request)
  const reservedTokens = known === null ? null : Math.ceil(known * 0.2)
  const usable = known === null ? null : known - reservedTokens!
  return { inputTokens, capacity: known, reservedTokens, availableTokens: usable === null ? null : Math.max(0, usable - inputTokens), usedFraction: known === null ? null : Math.min(1, inputTokens / known), estimated: measured === undefined, model: request.model, compacting: false }
}
