import './backendFileFixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'



import {
  appendMemory,
  clearChat,
  deletePersonality,
  listPersonalities,
  readConfig,
  readMemory,
  readPersonality,
  saveChat,
  saveInstructions,
  savePersonality
} from '../src/backend/store'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'personalities-'))
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network disabled in tests') }))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await fs.rm(root, { recursive: true, force: true })
})

const chorus = (...p: string[]): string => join(root, '.valley', 'plugins', 'data', 'assistant', ...p)
const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false)

describe('personalities', () => {
  it('seeds complete defaults in a canonical Markdown personality', async () => {
    const cfg = await readConfig(root)
    expect(cfg.instructions).toContain('Default personality')
    expect(await exists(chorus('personalities', 'default', 'profile.json'))).toBe(false)
    expect(await listPersonalities(root)).toEqual([expect.objectContaining({ id: 'default', instructionsPath: '.valley/plugins/data/assistant/personalities/default/instructions.md' })])
  })

  it('readConfig reads instructions/routing from the default personality', async () => {
    await saveInstructions(root, 'CUSTOM BRIEF')
    const cfg = await readConfig(root)
    expect(cfg.instructions).toBe('CUSTOM BRIEF')
  })

  it('exactly one default — claiming it clears the flag on the previous default', async () => {
    await savePersonality(root, {
      id: 'default',
      name: 'Default',
      isDefault: true,
      instructions: 'default',
      routing: { auto: true, default: { provider: 'openai', model: 'gpt-5' }, rules: [] }
    })
    await savePersonality(root, {
      id: 'coder',
      name: 'Coder',
      isDefault: true,
      instructions: 'code well',
      routing: { auto: true, default: { provider: 'anthropic', model: 'claude-opus-4-8' }, rules: [] }
    })
    const list = await listPersonalities(root)
    expect(list.filter((p) => p.isDefault)).toHaveLength(1)
    expect(list.find((p) => p.isDefault)?.id).toBe('coder')
    expect((await readPersonality(root, 'default'))?.isDefault).toBe(false)
  })

  it('never deletes the default personality', async () => {
    await savePersonality(root, {
      id: 'default',
      name: 'Default',
      isDefault: true,
      instructions: 'default',
      routing: { auto: true, default: { provider: 'openai', model: 'gpt-5' }, rules: [] }
    })
    await deletePersonality(root, 'default')
    expect(await readPersonality(root, 'default')).not.toBeNull()
  })
})

describe('memory', () => {
  it('appends to a chat memory.jsonl and reads it back', async () => {
    await saveChat(root, { id: 'chat-mem', title: 'Mem', createdAt: 1, updatedAt: 2, model: null, messages: [{ role: 'user', content: 'hi' }] })
    await appendMemory(root, { id: 'chat-mem' }, { id: 'm1', summary: 'User prefers German', createdAt: 10, sourceChatId: 'chat-mem' })
    expect(await exists(chorus('chats', 'chat-mem', 'memory.jsonl'))).toBe(true)
    const mem = await readMemory(root, 'chat-mem')
    expect(mem).toHaveLength(1)
    expect(mem[0]).toMatchObject({ summary: 'User prefers German', sourceChatId: 'chat-mem' })
  })

  it('/clear (clearChat) wipes the thread but keeps memory.jsonl', async () => {
    await saveChat(root, { id: 'chat-mem2', title: 'Mem2', createdAt: 1, updatedAt: 2, model: null, messages: [{ role: 'user', content: 'hi' }] })
    await appendMemory(root, { id: 'chat-mem2' }, { id: 'm1', summary: 'keep me', createdAt: 10 })
    await clearChat(root, 'chat-mem2')
    expect(await exists(chorus('chats', 'chat-mem2', 'thread.jsonl'))).toBe(false)
    expect(await readMemory(root, 'chat-mem2')).toHaveLength(1)
  })
})
