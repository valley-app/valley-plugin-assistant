import type { AiStreamEvent } from './types'

export const STREAM_LIMITS = { bytes: 8 * 1024 * 1024, events: 65_536, toolCalls: 64, toolBytes: 256 * 1024, lineBytes: 1024 * 1024 } as const
const encoder = new TextEncoder()
export const utf8Bytes = (value: string): number => encoder.encode(value).byteLength

export function createStreamBudget() {
  let bytes = 0, events = 0, calls = 0
  return (event: AiStreamEvent | { type: string; [key: string]: unknown }): void => {
    if (event.type === 'text' && typeof event.text !== 'string'
      || event.type === 'error' && typeof event.error !== 'string'
      || event.type === 'usage' && [event.inputTokens, event.outputTokens].some(value => value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0))
      || !['text', 'tool_call', 'usage', 'error', 'done', 'continuation'].includes(event.type)) throw new Error('Invalid provider stream event')
    if (event.type === 'tool_call') {
      const call = event.call as { id?: unknown; name?: unknown; arguments?: unknown } | undefined
      if (!call || typeof call.id !== 'string' || !call.id || call.id.length > 256 || typeof call.name !== 'string' || !call.name || call.name.length > 256
        || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) throw new Error('Invalid provider tool call')
    }
    const encoded = JSON.stringify(event)
    bytes += utf8Bytes(encoded)
    if (++events > STREAM_LIMITS.events || bytes > STREAM_LIMITS.bytes) throw new Error('Provider response exceeds the stream limit')
    if (event.type === 'tool_call' && (++calls > STREAM_LIMITS.toolCalls || utf8Bytes(JSON.stringify(event.call)) > STREAM_LIMITS.toolBytes)) throw new Error('Provider tool calls exceed the stream limit')
  }
}
