import type { AiChatThread, AiModelRef } from '../types'
import { applyGeneratedTitle, readChat } from './threads'
import { backendApi, withBackgroundOperation } from './runtime'
import { compileInstructionRoots } from './configuration/instructions'
import { readInstructionNote } from './configuration/markdown'
import { effectiveSettings } from './configuration/settings'

const active = new WeakMap<object, Set<string>>()
export function meaningfulNamingContent(thread: AiChatThread): string | null {
  for (const message of thread.messages) {
    if (message.role !== 'user' || message.error || message.ingestionState === 'pending') continue
    const text = (message.displayContent || message.content).trim()
    if (text && !/^\/(clear|help|model|profile|guard)\b/i.test(text) && !/^\[(?:attachment|sticker|audio|video)(?:\s[^\]]*)?\]$/i.test(text)) return text.slice(0, 4000)
  }
  return null
}

export function normalizeGeneratedTitle(value: string): string | null {
  const title = value.trim().replace(/^['"“”«»]+|['"“”«»]+$/g, '').replace(/^#+\s*/, '').replace(/[.!。]+$/, '').trim()
  if (!title || /[\r\n\u0000-\u001f]/.test(title) || title.length > 72 || /\[\[|```|https?:\/\//.test(title)) return null
  return title
}

export async function generateChatName(root: string, chatId: string, model?: AiModelRef): Promise<boolean> {
  const api = backendApi(), settings = await effectiveSettings(root)
  if (!settings.automaticChatNaming || !model) return false
  const thread = await readChat(root, chatId)
  if (!thread || thread.titleOrigin !== 'fallback') return false
  const content = meaningfulNamingContent(thread)
  if (!content) return false
  const instructions = await compileInstructionRoots([settings.instructions.chatNaming], reference => readInstructionNote(root, reference))
  const requestId = crypto.randomUUID()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      api.ai.complete({ ...model, requestId, messages: [{ role: 'system', content: instructions.text }, { role: 'user', content: `Name the conversation described by this source data:\n${JSON.stringify({ request: content })}` }], maxTokens: 64, temperature: 0.2, origin: 'harness', operation: 'assistant.chat-name', conversationId: chatId }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Automatic chat naming timed out')), 12000) }),
    ])
    const title = normalizeGeneratedTitle(response.text)
    if (!title || backendApi() !== api) return false
    return applyGeneratedTitle(root, chatId, title, { title: thread.title, revision: thread.titleRevision ?? 0 })
  } finally { clearTimeout(timer); await api.ai.cancel(requestId).catch(() => undefined) }
}

export function scheduleChatNaming(root: string, chatId: string, model?: AiModelRef): void {
  const api = backendApi(), pending = active.get(api) ?? new Set<string>()
  active.set(api, pending)
  if (pending.has(chatId)) return
  pending.add(chatId)
  void withBackgroundOperation(root, () => generateChatName(root, chatId, model)).catch(error => {
    api.rpc.emit('naming.error', { chatId, error: error instanceof Error ? error.message : String(error) })
  }).finally(() => pending.delete(chatId))
}
