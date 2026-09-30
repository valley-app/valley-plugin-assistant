import '../backendFileFixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { ensureScaffold, readConfig, savePersonality, readPersonality, DEFAULT_ROUTING, readCommands, saveCommands } from '../../src/backend/store'
import { applyGeneratedTitle, readChat, renameChat, saveChat } from '../../src/backend/threads'
import { compileInstructionRoots, compileInstructions, INSTRUCTION_LIMIT } from '../../src/backend/configuration/instructions'
import { configurationPath, formatMarkdown, noteReference, parseMarkdown, readInstructionNote, utf8Size } from '../../src/backend/configuration/markdown'
import { configurationDiagnostics, effectiveSettings, saveSettings } from '../../src/backend/configuration/settings'
import { readChannelConfigurations, writeChannelConfigurations } from '../../src/backend/configuration/channels'
import { readSpeechSettings, saveSpeechSettings } from '../../src/backend/configuration/speech'
import { meaningfulNamingContent, generateChatName, normalizeGeneratedTitle } from '../../src/backend/chatNaming'
import { backendApi } from '../../src/backend/runtime'
import type { AiChatThread } from '../../src/types'

let root: string
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'assistant-markdown-')) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })
const thread = (patch: Partial<AiChatThread> = {}): AiChatThread => ({ id: 'chat-1', title: 'New chat', titleOrigin: 'fallback', titleRevision: 0, createdAt: 1, updatedAt: 2, messages: [{ role: 'user', content: 'Describe forest habitats' }], ...patch })
const saveNote = (name: string, text: string) => fs.writeFile(configurationPath(root, name), text)

describe('canonical Markdown configuration', () => {
  it('migrates host defaults only once and retains the last valid global snapshot visibly', async () => {
    const get = vi.spyOn(backendApi().settings, 'get').mockReturnValue({ showTelegram: false, showTimestamps: false })
    expect(await effectiveSettings(root)).toMatchObject({ showTelegram: false, showTimestamps: false, importMaxBytes: 33554432 })
    get.mockReturnValue({ showTelegram: true })
    expect((await effectiveSettings(root)).showTelegram).toBe(false)
    await saveNote('settings.md', '---\nshowTelegram: nope\n---\n')
    expect((await effectiveSettings(root)).showTelegram).toBe(false)
    expect(configurationDiagnostics()).toContainEqual(expect.objectContaining({ retained: true, message: expect.stringContaining('showTelegram') }))
    await expect(saveSettings(root, { showTelegram: true })).rejects.toThrow()
  })

  it('persists independent chronological preferences for each sidebar source', async () => {
    expect(await effectiveSettings(root)).toMatchObject({ sidebarChronological: false, telegramChronological: false, whatsappChronological: false })
    await saveSettings(root, { telegramChronological: true })
    expect(await effectiveSettings(root)).toMatchObject({ sidebarChronological: false, telegramChronological: true, whatsappChronological: false })
    await saveSettings(root, { sidebarChronological: true, whatsappChronological: true })
    await saveSettings(root, { telegramChronological: false })
    expect(await effectiveSettings(root)).toMatchObject({ sidebarChronological: true, telegramChronological: false, whatsappChronological: true })
  })

  it('preserves Markdown instructions and advanced values when native preferences change', async () => {
    const settings = await effectiveSettings(root)
    await saveNote('settings.md', formatMarkdown({ ...settings, commandReporting: 'concise', telegramChronological: true }, '# Meadow instructions\n\nPreserve **moss** observations.'))
    await saveSettings(root, { attachmentFolder: 'meadow/media', showTelegram: false })
    expect(await effectiveSettings(root)).toMatchObject({ commandReporting: 'concise', telegramChronological: true, attachmentFolder: 'meadow/media', showTelegram: false })
    expect(await fs.readFile(configurationPath(root, 'settings.md'), 'utf8')).toContain('Preserve **moss** observations.')
    await expect(saveSettings(root, { importMaxBytes: -1 })).rejects.toThrow()
    expect((await effectiveSettings(root)).attachmentFolder).toBe('meadow/media')
  })

  it('does not rewrite derived snapshots on unchanged reads', async () => {
    await effectiveSettings(root)
    const file = configurationPath(root, 'runtime/configuration/settings.last-valid.json')
    const before = await fs.stat(file)
    await effectiveSettings(root)
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs)
  })

  it('uses the selected personality and preserves legacy prose and routing migration', async () => {
    await ensureScaffold(root)
    await savePersonality(root, { id: 'naturalist', name: 'Naturalist', isDefault: false, instructions: 'Describe tree species.', routing: { ...DEFAULT_ROUTING, auto: false } })
    await saveSettings(root, { defaultProfileId: 'naturalist' })
    expect(await readConfig(root)).toMatchObject({ instructions: 'Describe tree species.', routing: { auto: false } })
    const file = configurationPath(root, 'personalities/naturalist/instructions.md')
    await fs.writeFile(file, '---\nid: wrong\n---\n')
    expect((await readPersonality(root, 'naturalist'))?.instructions).toBe('Describe tree species.')
  })

  it('treats Markdown as conversation authority, including removing an optional override', async () => {
    const original = thread({ attachmentParser: 'parser-a' })
    await saveChat(root, original)
    const current = (await readChat(root, original.id))!
    await fs.writeFile(join(root, current.instructionsPath!), formatMarkdown({ includes: [] }, 'Use concise answers.'))
    expect((await readChat(root, original.id))?.attachmentParser).toBeUndefined()
    original.messages.push({ role: 'assistant', content: 'Ready' })
    await saveChat(root, original)
    expect((await readChat(root, original.id))?.attachmentParser).toBeUndefined()
    const note = await fs.readFile(join(root, current.instructionsPath!), 'utf8')
    expect(note).toContain('Use concise answers.')
    await fs.writeFile(join(root, current.instructionsPath!), '---\nmodel: invalid\n---\n')
    expect((await readChat(root, original.id))?.attachmentParser).toBeUndefined()
    expect(configurationDiagnostics()).toContainEqual(expect.objectContaining({ retained: true, path: join(root, current.instructionsPath!) }))
  })

  it('keeps credentials and revoked Guard policies out of retained channel behavior', async () => {
    const config = { telegram: { type: 'telegram', name: 'Bot', allowFrom: [], enabled: false, guard: { defaultWrite: 'allow' } } }
    await writeChannelConfigurations(root, config)
    expect(await readChannelConfigurations(root, {})).toMatchObject(config)
    await saveNote('runtime/configuration/channel-policies.json', '{}')
    await saveNote('config/channels/telegram.md', '---\nenabled: wrong\n---\n')
    const result = await readChannelConfigurations(root, {})
    expect(result).toMatchObject({ telegram: { name: 'Bot' } })
    expect((result as typeof config).telegram.guard).toBeUndefined()
    await expect(writeChannelConfigurations(root, { x: { ...config.telegram, token: 'secret' } })).rejects.toThrow()
  })

  it('keeps speech settings independent and requires an actual selected voice', async () => {
    expect(await readSpeechSettings(root)).toMatchObject({ provider: 'elevenlabs', fallbackProvider: null, liveMode: 'push-to-talk' })
    expect((await readSpeechSettings(root)).voiceId).toBeUndefined()
    expect(await saveSpeechSettings(root, { provider: 'openai', voiceId: 'coral', transcriptionProvider: 'elevenlabs' })).toMatchObject({ provider: 'openai', voiceId: 'coral', transcriptionProvider: 'elevenlabs' })
    await expect(saveSpeechSettings(root, { apiKey: 'secret' })).rejects.toThrow()
  })

  it('reads custom command text directly from Markdown edits', async () => {
    await saveCommands(root, [{ name: 'review', prompt: 'First prompt' }])
    await saveNote('commands/review.md', formatMarkdown({ name: 'review', includes: [] }, 'Updated Markdown prompt'))
    expect(await readCommands(root)).toEqual([{ name: 'review', prompt: 'Updated Markdown prompt' }])
    await ensureScaffold(root)
    await saveNote('commands/review.md', formatMarkdown({ name: 'review', includes: ['../instructions/external.md'] }, 'Updated Markdown prompt'))
    expect((await readCommands(root))[0].prompt).toContain('Work outside the vault')
    await saveCommands(root, [{ name: 'review', prompt: 'Review again' }])
    expect(await fs.readFile(configurationPath(root, 'commands/review.md'), 'utf8')).toContain('../instructions/external.md')
  })
})

describe('bounded explicit instruction graphs', () => {
  it('follows explicit includes once and leaves ordinary links as references', async () => {
    const read = vi.fn(async (path: string) => path === 'root.md' ? formatMarkdown({ includes: ['[[child]]', 'child.md'] }, 'See [[not-an-instruction]].') : 'Linked behavior')
    const bundle = await compileInstructionRoots(['root.md'], read)
    expect(bundle.sources.map(source => source.path)).toEqual(['root.md', 'child.md'])
    expect(read).toHaveBeenCalledTimes(2)
    expect(bundle.bytes).toBe(utf8Size(bundle.text))
  })

  it('enforces the exact UTF-8 byte boundary rather than character count', async () => {
    const overhead = utf8Size('## Instruction source: root.md\n\n')
    const body = 'ä'.repeat((INSTRUCTION_LIMIT - overhead) / 2)
    const bundle = await compileInstructionRoots(['root.md'], async () => body)
    expect(bundle.bytes).toBe(INSTRUCTION_LIMIT)
    expect((await compileInstructionRoots(['root.md'], async () => `${body.slice(0, -1)}x`)).bytes).toBe(8191)
    await expect(compileInstructionRoots(['root.md'], async () => `${body}x`)).rejects.toThrow('8192')
  })

  it('rejects cycles, traversal, duplicate YAML keys, aliases and unknown settings', async () => {
    await expect(compileInstructionRoots(['a.md'], async path => formatMarkdown({ includes: [path === 'a.md' ? 'b.md' : 'a.md'] }, 'body'))).rejects.toThrow('cycle')
    expect(() => noteReference('../outside.md')).toThrow()
    expect(() => noteReference('.valley/plugins/data/other/secret.md')).toThrow()
    expect(() => parseMarkdown('---\nx: 1\nx: 2\n---\n', z.object({ x: z.number() }))).toThrow()
    expect(() => parseMarkdown('---\nx: &x [1]\ny: *x\n---\n', z.object({}).passthrough())).toThrow()
  })

  it('retains only the same validated instruction scope and does not bypass current Guard', async () => {
    await ensureScaffold(root)
    Object.assign(backendApi(), { storage: { open: vi.fn(async () => ({ handle: 'external-instruction' })), close: vi.fn(async () => {}), stat: vi.fn(async () => ({ kind: 'file', size: 25 })), readBytes: vi.fn(async () => ({ base64: btoa('Describe forest habitats.'), done: true })) } })
    const scope = { conversationId: 'scope-a', mode: 'execute' as const, context: 'VAULT' as const, projectInstruction: 'Notes/behavior.md' }
    const first = await compileInstructions(root, scope)
    expect(first.bytes).toBeLessThanOrEqual(INSTRUCTION_LIMIT)
    const complete = await compileInstructions(root, { conversationId: 'complete', mode: 'plan', context: 'MIXED', source: 'whatsapp', voice: true })
    expect(complete.bytes).toBeLessThanOrEqual(INSTRUCTION_LIMIT)
    await saveNote('instructions/global.md', 'large'.repeat(3000))
    expect(await compileInstructions(root, scope)).toMatchObject({ hash: first.hash, retained: true })
    await expect(compileInstructions(root, { ...scope, conversationId: 'scope-b' })).rejects.toThrow('8192')
    vi.spyOn(backendApi().policy, 'checkFile').mockRejectedValue(new Error('revoked'))
    await expect(compileInstructions(root, scope)).rejects.toThrow('revoked')
  })

  it('reads owned instruction metadata through its storage scope while preserving vault restrictions', async () => {
    await ensureScaffold(root)
    const guard = vi.spyOn(backendApi().policy, 'checkFile').mockRejectedValue(new Error('Blocked by Guards'))
    const scope = { conversationId: 'owned-instructions', mode: 'execute' as const, context: 'VAULT' as const }
    const first = await compileInstructions(root, scope)
    expect(first.sources.some(source => source.path.endsWith('/instructions/global.md'))).toBe(true)
    expect(guard).not.toHaveBeenCalled()
    await saveNote('instructions/global.md', 'large'.repeat(3000))
    expect(await compileInstructions(root, scope)).toMatchObject({ hash: first.hash, retained: true })
    expect(guard).not.toHaveBeenCalled()
    await expect(readInstructionNote(root, 'Notes/private.md')).rejects.toThrow('Blocked by Guards')
    expect(guard).toHaveBeenCalledWith('Notes/private.md', 'read')
    await expect(readInstructionNote(root, '.valley/private.md')).rejects.toThrow('another plugin')
    await expect(readInstructionNote(root, '.valley/plugins/data/assistant/../other/private.md')).rejects.toThrow('another plugin')
  })
})

describe('automatic conversation naming', () => {
  it.each(['telegram', 'whatsapp'] as const)('preserves %s identity, timestamp and manual names through background races', async source => {
    const original = thread({ source, channelId: source, chatRef: '123', channelName: 'Bot', title: 'Bot · Person' })
    await saveChat(root, original)
    expect(await applyGeneratedTitle(root, original.id, 'Forest habitats', { title: original.title, revision: 0 })).toBe(true)
    expect(await readChat(root, original.id)).toMatchObject({ title: 'Forest habitats', titleOrigin: 'generated', channelIdentity: 'Bot · Person', updatedAt: 2 })
    await renameChat(root, original.id, 'My name')
    expect(await applyGeneratedTitle(root, original.id, 'Late title', { title: 'Forest habitats', revision: 1 })).toBe(false)
    await saveChat(root, original)
    expect(await readChat(root, original.id)).toMatchObject({ title: 'My name', titleOrigin: 'manual', updatedAt: 2 })
  })

  it('names meaningful transcribed content while preserving all unknown-origin legacy names', async () => {
    const complete = vi.fn(async () => ({ text: '  “Forest review”  ' }))
    Object.assign(backendApi().ai, { complete })
    await saveChat(root, thread({ messages: [{ role: 'user', content: 'Explain forests from this voice transcript.' }] }))
    expect(await generateChatName(root, 'chat-1', { provider: 'openai', model: 'test' })).toBe(true)
    expect((await readChat(root, 'chat-1'))?.title).toBe('Forest review')
    await saveChat(root, thread({ id: 'legacy', title: 'Existing chosen title', titleOrigin: undefined }))
    expect(await generateChatName(root, 'legacy', { provider: 'openai', model: 'test' })).toBe(false)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(meaningfulNamingContent(thread({ messages: [{ role: 'user', content: '[sticker]' }] }))).toBeNull()
    expect(normalizeGeneratedTitle('A\nB')).toBeNull()
  })
})
