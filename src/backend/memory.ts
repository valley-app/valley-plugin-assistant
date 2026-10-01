import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
import { t, backendApi } from './runtime'
import * as fs from './filesystem'
import path from 'path-browserify'
import type { AiChatThread, AiMemoryEntry } from '../types'
import { chatDir, chorusChatsDir, isSafeName, safeSegment } from './paths'
import { assertChatWritable } from './attachments'
import { queuedAppendJsonl, runExclusive } from './fileQueue'
import { readText } from './repositoryFiles'
import { resolveChatDir } from './threads'

const memoryFile = (dir: string): string => path.join(dir, 'memory.jsonl')

// ── Memory (per-chat memory.jsonl, explicit summarize flow) ───────────────────

/**
 * Append one extracted fact to a chat's `memory.jsonl`. Runs the authoritative
 * file guard first (memory lives under `Meadow/Chorus`, so a `deny`/hard-block
 * is honored) and serializes the write per-file (C16). The chat folder is
 * resolved from `thread` when given (so a brand-new remote-channel chat works), else
 * by id.
 */
export async function appendMemory(
  vaultRoot: string,
  ref: { id: string } | AiChatThread,
  entry: AiMemoryEntry,
  api: PluginBackendOperationContext['api'] = backendApi()
): Promise<void> {
  if (!isSafeName(ref.id)) throw new Error(t('assistant.backend.invalidChat', { value: ref.id }))
  return runExclusive(`chat:${ref.id}`, async () => {
  await assertChatWritable(ref.id, api)
  const dir = 'messages' in ref ? chatDir(vaultRoot, ref) : (await resolveChatDir(vaultRoot, ref.id, api)) ?? path.join(chorusChatsDir(vaultRoot), safeSegment(ref.id))
  const file = memoryFile(dir)
  await fs.mkdir(dir, { recursive: true }, api)
  await queuedAppendJsonl(file, [entry], api)
  }, api)
}

/** Read a chat's extracted long-term memory (tolerant; `[]` when absent). */
export async function readMemory(vaultRoot: string, id: string, api: PluginBackendOperationContext['api'] = backendApi()): Promise<AiMemoryEntry[]> {
  if (!isSafeName(id)) return []
  const dir = await resolveChatDir(vaultRoot, id, api)
  if (!dir) return []
  const text = await readText(memoryFile(dir), api)
  if (!text) return []
  const out: AiMemoryEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as AiMemoryEntry
      if (parsed && typeof parsed.summary === 'string') out.push(parsed)
    } catch {
      /* skip a malformed memory line */
    }
  }
  return out
}
