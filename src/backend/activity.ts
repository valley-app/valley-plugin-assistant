import path from 'path-browserify'
import { z } from 'zod'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { redactSecrets } from '@valley/plugin-sdk'
import type { ProjectActivity } from '@valley/plugin-sdk/pluginExecution'
import { backendApi, VAULT_ROOT } from './runtime'
import { resolveChatDir } from './threads'
import { assertChatWritable } from './attachments'
import { runExclusive } from './fileQueue'
import * as fs from './filesystem'
const identity = z.string().min(1).max(256)
const eventSchema = z.object({ runId: identity, callId: identity, parentCallId: identity.optional(), name: z.string().min(1).max(256), state: z.enum(['running', 'approval', 'completed', 'failed', 'cancelled']), timestamp: z.number().finite(), arguments: z.record(z.unknown()), result: z.unknown().optional(), outputRef: z.string().regex(/^[a-f0-9]{64}$/).optional(), argumentsRef: z.string().regex(/^[a-f0-9]{64}$/).optional(), resultRef: z.string().regex(/^[a-f0-9]{64}$/).optional(), diffRef: z.string().max(256).optional() }).strict()
const reference = (runId: string, callId: string) => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([runId, callId]))))
const live = new WeakMap<object, Set<string>>()
const recovered = new WeakMap<object, Set<string>>()
function sessions(map: WeakMap<object, Set<string>>): Set<string> {
  const owner = backendApi(), values = map.get(owner) ?? new Set<string>()
  map.set(owner, values)
  return values
}
async function recoverActivity(chatId: string, dir: string): Promise<void> {
  const complete = sessions(recovered)
  if (complete.has(chatId)) return
  const file = path.join(dir, 'activity.jsonl')
  const location = await fs.storageLocation(file, 'read')
  if (!await backendApi().storage.stat(location)) { complete.add(chatId); return }
  const raw = await fs.readFile(file)
  const lines = raw.split('\n'), latest = new Map<string, ProjectActivity>()
  let repaired = false
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue
    try {
      const event = eventSchema.parse(JSON.parse(lines[index]))
      latest.set(`${chatId}:${event.runId}:${event.callId}`, event)
    } catch (error) {
      if (index !== lines.length - 1) throw new Error(`Invalid saved activity at line ${index + 1}: ${String(error)}`)
      await fs.atomicWriteFile(path.join(dir, `activity-interrupted-${crypto.randomUUID()}.jsonl`), raw)
      lines.pop(); repaired = true
      backendApi().rpc.emit('backendError', 'An interrupted activity record was preserved for recovery.')
    }
  }
  if (repaired) await fs.atomicWriteFile(file, lines.join('\n') + '\n')
  else if (raw && !raw.endsWith('\n')) await fs.appendFile(file, '\n')
  for (const [key, event] of latest) {
    if ((event.state === 'running' || event.state === 'approval') && !sessions(live).has(key)) {
      await fs.appendFile(file, JSON.stringify({ ...event, state: 'cancelled', timestamp: Date.now(), result: { error: 'Interrupted when Assistant stopped' } }) + '\n')
    }
  }
  complete.add(chatId)
}
async function directory(chatId: string): Promise<string> {
  const dir = await resolveChatDir(VAULT_ROOT, chatId)
  if (!dir) throw new Error('Conversation is unavailable')
  return dir
}
export function* outputChunks(text: string): Generator<string> {
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + 64000)
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
    yield text.slice(offset, end)
    offset = end
  }
}
export async function persistActivityText(chatId: string, runId: string, callId: string, value: string): Promise<string> {
  const text = redactSecrets(value)
  let outputRef = ''
  for (const chunk of outputChunks(text || ' ')) outputRef = await activityRequest('output', { chatId, runId, callId, text: chunk, first: !outputRef }) as string
  return outputRef
}
export async function appendActivity(chatId: string, value: ProjectActivity): Promise<void> {
  const event = eventSchema.parse(value)
  for (const field of ['arguments', 'result'] as const) {
    const text = JSON.stringify(event[field])
    if (text && text.length > 16000) {
      const reference = await persistActivityText(chatId, event.runId, event.callId + ':' + field, text)
      if (field === 'arguments') event.argumentsRef = reference
      else event.resultRef = reference
      event[field] = { preview: redactSecrets(text).slice(0, 8000) }
    }
  }
  if (new TextEncoder().encode(JSON.stringify(event)).byteLength > 100000) throw new Error('Activity metadata exceeds its limit')
  await runExclusive(`chat:${chatId}`, async () => {
    await assertChatWritable(chatId)
    const dir = await directory(chatId)
    await recoverActivity(chatId, dir)
    const redacted = redactSecrets(JSON.stringify(event))
    await fs.appendFile(path.join(dir, 'activity.jsonl'), redacted + '\n')
    const key = `${chatId}:${event.runId}:${event.callId}`
    if (event.state === 'running' || event.state === 'approval') sessions(live).add(key)
    else sessions(live).delete(key)
    backendApi().rpc.emit('activity', { chatId, event: JSON.parse(redacted) })
  })
}
export async function activityRequest(method: string, payload: unknown): Promise<unknown> {
  if (method === 'append') {
    const input = z.object({ chatId: identity, event: eventSchema }).strict().parse(payload)
    await appendActivity(input.chatId, input.event)
    return
  }
  if (method === 'output') {
    const input = z.object({ chatId: identity, runId: identity, callId: identity, text: z.string().max(256000), first: z.boolean() }).strict().parse(payload)
    const outputRef = reference(input.runId, input.callId)
    await runExclusive(`chat:${input.chatId}`, async () => {
      await assertChatWritable(input.chatId)
      const dir = path.join(await directory(input.chatId), 'output')
      await fs.mkdir(dir, { recursive: true })
      const file = path.join(dir, outputRef + '.txt')
      if (input.first) await fs.atomicWriteFile(file, redactSecrets(input.text))
      else await fs.appendFile(file, redactSecrets(input.text))
    })
    return outputRef
  }
  const input = z.object({ chatId: identity, offset: z.number().int().nonnegative().default(0), outputRef: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(payload)
  const dir = await resolveChatDir(VAULT_ROOT, input.chatId)
  if (!dir && method === 'list') return { events: [], done: true, nextOffset: 0 }
  if (!dir) throw new Error('Conversation is unavailable')
  if (method === 'readOutput') {
    if (!input.outputRef) throw new Error('Select a tool output')
    return backendApi().storage.readBytes(await fs.storageLocation(path.join(dir, 'output', input.outputRef + '.txt'), 'read'), { offset: input.offset, maxBytes: 65536 })
  }
  if (method !== 'list') throw new Error('Unknown activity operation')
  if (input.offset === 0) await runExclusive(`chat:${input.chatId}`, () => recoverActivity(input.chatId, dir))
  const location = await fs.storageLocation(path.join(dir, 'activity.jsonl'), 'read')
  if (!await backendApi().storage.stat(location)) return { events: [], done: true, nextOffset: 0 }
  const chunk = await backendApi().storage.readBytes(location, { offset: input.offset, maxBytes: 256 * 1024 })
  const bytes = Uint8Array.from(atob(chunk.base64), char => char.charCodeAt(0))
  const end = chunk.done ? bytes.length : bytes.lastIndexOf(10) + 1
  if (!end && !chunk.done) throw new Error('Activity record exceeds its limit')
  const events = new TextDecoder().decode(bytes.subarray(0, end)).split('\n').filter(Boolean).map(line => eventSchema.parse(JSON.parse(line)))
  return { events, done: chunk.done, nextOffset: input.offset + end }
}
