import { assertCommandOutput } from './commandContracts'
import { sharedConnections, discoveredModels } from './backendFileFixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { AiChatThread } from '../src/types'



import { CHAT_PAGE_SIZE, listChatPage } from '../src/backend/threads'
import {
  deleteChat,
  ensureScaffold,
  listChats,
  listConnections,
  listPersonalities,
  normalizeCommands,
  readChat,
  renameChat,
  readCommands,
  readCommandsSnapshot,
  readPersonality,
  readConfig,
  saveChat,
  saveCommands,
  savePersonality
} from '../src/backend/store'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'assistant-store-'))
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network disabled in tests')
    })
  )
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await fs.rm(root, { recursive: true, force: true })
})

describe('assistant store', () => {
  it('scaffolds linked Markdown defaults and a usable personality', async () => {
    await ensureScaffold(root)
    const dir = join(root, '.valley', 'plugins', 'data', 'assistant')
    expect(await fs.readFile(join(dir, 'README.md'), 'utf8')).toContain('.valley/plugins/data/assistant')
    expect(await fs.readFile(join(dir, 'rules', 'tone.md'), 'utf8')).toContain('Be concise and direct')
    expect(await fs.readFile(join(dir, 'personalities/default/instructions.md'), 'utf8')).toContain('schemaVersion: 1')
  })

  it('readConfig excludes undiscovered local models without leaking keys', async () => {
    const cfg = await readConfig(root)
    expect(cfg.instructions.length).toBeGreaterThan(0)
    expect(cfg.providers.find((p) => p.provider === 'ollama')?.configured).toBe(false)
    expect(cfg.providers.find((p) => p.provider === 'anthropic')?.configured).toBe(false)
    // No secret values are ever present on the status object.
    expect(JSON.stringify(cfg.providers)).not.toContain('sk-')
  })

  it('readConfig reports live Ollama models for the chat selector', async () => {
    sharedConnections.mockResolvedValue([{ id: 'ollama-work', provider: 'ollama', providerCapabilities: ['chat'], configured: true, models: [{ id: 'qwen3.5:4b' }, { id: 'llama3.2:3b' }] }])

    discoveredModels.mockResolvedValue([{ provider: 'ollama', id: 'qwen3.5:4b' }, { provider: 'ollama', id: 'llama3.2:3b' }])
    const cfg = await readConfig(root)
    expect(discoveredModels).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'ollama-work' }))
    const ollama = cfg.providers.find((p) => p.provider === 'ollama')
    expect(ollama?.models.map((m) => m.id)).toEqual(['qwen3.5:4b', 'llama3.2:3b'])
  })

  it('keeps speech-only connections out of the reasoning selector', async () => {
    discoveredModels.mockClear()
    const chat = { id: 'openai-work', provider: 'openai', providerCapabilities: ['chat', 'speech'], requiresKey: true, configured: true, models: [{ id: 'reasoning-model' }] }
    sharedConnections.mockResolvedValue([
      { id: 'elevenlabs-voice', provider: 'elevenlabs', providerCapabilities: ['speech'], requiresKey: true, configured: true, models: [{ id: 'eleven_flash_v2_5' }] },
      chat
    ])

    expect(await listConnections(root)).toEqual([chat])
    expect(discoveredModels).not.toHaveBeenCalled()
  })

  it('round-trips chat threads (save → list → read → delete)', async () => {
    const thread: AiChatThread = {
      id: 'chat-1',
      title: 'Greeting',
      createdAt: 1,
      updatedAt: 2,
      model: null,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' }
      ]
    }
    await saveChat(root, thread)
    expect(await listChats(root)).toContainEqual({ id: 'chat-1', title: 'Greeting', updatedAt: 2, preview: 'hi there' })
    assertCommandOutput('listChats', {}, { chats: await listChats(root) })
    const read = await readChat(root, 'chat-1')
    assertCommandOutput('readChat', {}, { thread: read })
    expect(read?.messages).toHaveLength(2)
    expect(read?.messages[1]).toMatchObject({ role: 'assistant', content: 'hi there' })
    await deleteChat(root, 'chat-1')
    expect(await readChat(root, 'chat-1')).toBeNull()
  })

  it('refuses an unsafe chat id', async () => {
    await expect(saveChat(root, { id: '../escape', title: 'x', createdAt: 1, updatedAt: 1, messages: [] })).rejects.toThrow()
  })

  it('persists edits to existing messages while preserving append-only extensions', async () => {
    const thread: AiChatThread = {
      id: 'edited-chat', title: 'Forest', createdAt: 1, updatedAt: 2,
      messages: [{ role: 'user', content: 'original' }, { role: 'assistant', content: 'answer' }]
    }
    await saveChat(root, thread)
    thread.messages[0] = { role: 'user', content: 'corrected' }
    await saveChat(root, thread)
    expect((await readChat(root, thread.id))?.messages).toEqual(thread.messages)
    thread.messages.push({ role: 'user', content: 'follow-up' })
    await saveChat(root, thread)
    expect((await readChat(root, thread.id))?.messages).toEqual(thread.messages)
    const file = join(root, '.valley', 'plugins', 'data', 'assistant', 'chats', thread.id, 'thread.jsonl')
    expect((await fs.readFile(file, 'utf8')).trimEnd().split('\n')).toHaveLength(3)
  })

  it('normalizeCommands slugifies, drops invalid/duplicate, and strips leading slashes', () => {
    const out = normalizeCommands([
      { name: 'Stand Up', prompt: 'do standup' }, // name is not a slug → dropped (no auto-slug here; renderer slugifies)
      { name: '/brief', prompt: 'morning brief' }, // leading slash stripped
      { name: 'brief', prompt: 'second brief' }, // duplicate name → dropped
      { name: 'empty', prompt: '   ' }, // empty prompt → dropped
      { name: 'ok', prompt: 'fine', description: '  a note  ' },
      'garbage',
      null
    ])
    expect(out).toEqual([
      { name: 'brief', prompt: 'morning brief' },
      { name: 'ok', prompt: 'fine', description: 'a note' }
    ])
  })

  it('round-trips overall custom commands through linked Markdown notes', async () => {
    expect(await readCommands(root)).toEqual([])
    await saveCommands(root, [{ name: 'fieldlog', prompt: 'Summarize the habitat survey.', description: 'daily' }], (await readCommandsSnapshot(root)).configurationRevisions)
    expect(await readCommands(root)).toEqual([{ name: 'fieldlog', prompt: 'Summarize the habitat survey.', description: 'daily' }])
    const onDisk = await fs.readFile(join(root, '.valley', 'plugins', 'data', 'assistant', 'commands/fieldlog.md'), 'utf8')
    expect(onDisk).toContain('name: fieldlog')
    expect(onDisk).toContain('Summarize the habitat survey.')
  })

  it('persists per-chat custom commands on the thread (settings.json)', async () => {
    const thread: AiChatThread = {
      id: 'chat-cmd',
      title: 'With commands',
      createdAt: 1,
      updatedAt: 2,
      model: null,
      messages: [{ role: 'user', content: 'hi' }],
      commands: [{ name: 'recap', prompt: 'Recap this chat.' }]
    }
    await saveChat(root, thread)
    const read = await readChat(root, 'chat-cmd')
    expect(read?.commands).toEqual([{ name: 'recap', prompt: 'Recap this chat.' }])
    // The summary surfaces the chat-scoped commands too.
    const summary = (await listChats(root)).find((c) => c.id === 'chat-cmd')
    expect(summary?.commands).toEqual([{ name: 'recap', prompt: 'Recap this chat.' }])
  })

  it('exposes a saved personality\'s instructions/routing as vault-relative paths', async () => {
    const cfg = await readConfig(root)
    await savePersonality(root, {
      configurationRevision: (await readPersonality(root, 'default'))!.configurationRevision,
      id: 'default',
      name: 'Default',
      isDefault: true,
      instructions: cfg.instructions,
      routing: cfg.routing
    })
    const [def] = await listPersonalities(root)
    expect(def.id).toBe('default')
    expect(def.instructionsPath).toBe('.valley/plugins/data/assistant/personalities/default/instructions.md')
    expect(def.routingPath).toBe(def.instructionsPath)
  })

  it('persists telegram-sourced thread metadata through save → list → read', async () => {
    const thread: AiChatThread = {
      id: 'tg-telegram-test-chat-1001',
      title: 'Telegram · Fern',
      createdAt: 1,
      updatedAt: 2,
      model: null,
      messages: [{ role: 'user', content: 'hi from telegram' }],
      source: 'telegram',
      channelId: 'telegram',
      chatRef: 'test-chat-1001',
      channelName: 'Field bot'
    }
    await saveChat(root, thread)
    // The conversation list carries the source + connection name for sidebar grouping.
    expect(await listChats(root)).toContainEqual({
      id: 'tg-telegram-test-chat-1001',
      title: 'Telegram · Fern',
      updatedAt: 2,
      preview: 'hi from telegram',
      source: 'telegram',
      channelId: 'telegram',
      channelName: 'Field bot'
    })
    const read = await readChat(root, 'tg-telegram-test-chat-1001')
    expect(read).toMatchObject({ source: 'telegram', channelId: 'telegram', chatRef: 'test-chat-1001', channelName: 'Field bot' })
  })
})


it.each(['telegram', 'whatsapp'] as const)('preserves %s identity and last-chat timestamp across rename and save', async source => {
  const original: AiChatThread = { id: 'remote', title: 'Field bot · Fern', source, channelId: source, chatRef: 'fern', channelName: 'Field bot', createdAt: 1, updatedAt: 2, messages: [{ role: 'user', content: 'Hello' }] }
  await saveChat(root, original)
  await renameChat(root, original.id, 'Research')
  const renamed = (await readChat(root, original.id))!
  expect(renamed).toMatchObject({ title: 'Research', channelIdentity: 'Field bot · Fern', updatedAt: 2, messages: original.messages })
  await saveChat(root, renamed)
  await renameChat(root, original.id, 'Moon research')
  expect(await listChats(root)).toContainEqual(expect.objectContaining({ title: 'Moon research', channelIdentity: 'Field bot · Fern', updatedAt: 2 }))
})

it('lists 3,000 chats as bounded summary pages without message bodies', async () => {
  const chats = join(root, '.valley', 'plugins', 'data', 'assistant', 'chats')
  const body = 'Lichen and moss share the north face of the boulder; '.repeat(20)
  const write = async (index: number) => {
    const id = `chat-moss-${String(index).padStart(4, '0')}`, dir = join(chats, id)
    const messages = Array.from({ length: 12 }, (_, turn) => ({ role: turn % 2 ? 'assistant' : 'user', content: `${body}${index}-${turn}` }))
    const legacy = index % 500 === 0, empty = index % 997 === 0
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'settings.json'), JSON.stringify({ id, title: `Moss survey ${index}`, createdAt: index, updatedAt: index, ...(legacy ? {} : { messageCount: empty ? 0 : messages.length, preview: `Survey ${index}` }) }))
    await fs.writeFile(join(dir, 'thread.jsonl'), empty ? '' : messages.map(message => JSON.stringify(message)).join('\n'))
    return empty ? [] : [id]
  }
  const expected: string[] = []
  for (let start = 0; start < 3000; start += 250) expected.push(...(await Promise.all(Array.from({ length: 250 }, (_, offset) => write(start + offset)))).flat())
  const seen: string[] = []
  let cursor: string | undefined, pages = 0, total = 0
  do {
    const page = await listChatPage(root, cursor ? { cursor } : {})
    const bytes = new TextEncoder().encode(JSON.stringify(page)).byteLength
    expect(page.chats.length).toBeLessThanOrEqual(CHAT_PAGE_SIZE)
    expect(bytes).toBeLessThan(128 * 1024)
    for (const chat of page.chats) {
      expect(chat).not.toHaveProperty('messages')
      expect(chat.preview!.length).toBeLessThanOrEqual(240)
    }
    seen.push(...page.chats.map(chat => chat.id))
    total += bytes; pages++; cursor = page.cursor
  } while (cursor)
  expect(pages).toBe(Math.ceil(expected.length / CHAT_PAGE_SIZE))
  expect(total).toBeLessThan(2 * 1024 * 1024)
  expect(seen.sort()).toEqual(expected.sort())
  const all = await listChats(root)
  expect(all.map(chat => chat.id).sort()).toEqual(expected)
  expect(new TextEncoder().encode(JSON.stringify({ chats: all })).byteLength).toBeLessThan(2 * 1024 * 1024)
  expect(all.find(chat => chat.id === 'chat-moss-0500')!.preview).toBe(`${body}500-11`.slice(0, 240).trim())
}, 120000)
