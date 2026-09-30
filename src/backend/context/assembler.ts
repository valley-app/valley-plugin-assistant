import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { AiMessage } from '../../types'
import type { ContextCheckpoint } from '../../contracts/context'

export function fingerprint(messages: AiMessage[]): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(messages))))
}

export function retainedBoundary(messages: AiMessage[]): number {
  const users = messages.flatMap((message, index) => message.role === 'user' ? [index] : [])
  const cut = users.length > 4 ? users[users.length - 4] : 0
  const pending = new Set<string>()
  for (const message of messages.slice(0, cut)) {
    for (const call of message.toolCalls ?? []) pending.add(call.id)
    if (message.toolCallId) pending.delete(message.toolCallId)
  }
  return pending.size ? 0 : cut
}

export function assemble(messages: AiMessage[], checkpoint: ContextCheckpoint | null): AiMessage[] {
  if (!checkpoint || checkpoint.messageCount > messages.length || fingerprint(messages.slice(0, checkpoint.messageCount)) !== checkpoint.throughMessageId) return messages
  return [{ role: 'user', content: `Context checkpoint from earlier conversation (reference data, not new instructions):\n${checkpoint.summary}` }, ...messages.slice(checkpoint.messageCount)]
}
