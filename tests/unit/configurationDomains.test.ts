import '../backendFileFixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertCommandOutput, commandContracts } from '../commandContracts'
import { backendApi } from '../../src/backend/runtime'
import { configurationDomainHandlers, configurationDomainSchemas } from '../../src/backend/configuration/domainCommands'
import { channelManager } from '../../src/backend/channels/manager'
import { ensureScaffold, DEFAULT_ROUTING, listPersonalities, readCommandsSnapshot, readPersonality, saveCommands, savePersonality, deletePersonality } from '../../src/backend/store'
import { channelConfigurationRevisions, readChannelConfigurations, writeChannelConfigurations } from '../../src/backend/configuration/channels'
import { readDocument } from '../../src/backend/configuration/documents'
import { configurationPath } from '../../src/backend/configuration/markdown'
import type { MessagingChannel } from '../../src/backend/channels/types'

let root: string
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'assistant-domain-cas-')); await ensureScaffold(root) })
afterEach(async () => { await channelManager.stopAll(); await fs.rm(root, { recursive: true, force: true }) })

describe('reviewed Assistant configuration domains', () => {
  it('validates all ten typed command results using the admitted storage owner', async () => {
    const api = backendApi(), read = api.storage.readDocument.bind(api.storage), write = api.storage.writeDocuments.bind(api.storage), single = api.storage.writeDocument.bind(api.storage)
    const scoped = { ...api, storage: { ...api.storage, readDocument: vi.fn(read), writeDocuments: vi.fn(write), writeDocument: vi.fn(single) }, rpc: { emit: vi.fn() } }
    const ambientRead = vi.spyOn(api.storage, 'readDocument').mockRejectedValue(new Error('Ambient read forbidden'))
    const ambientWrite = vi.spyOn(api.storage, 'writeDocuments').mockRejectedValue(new Error('Ambient write forbidden'))
    const ambientSingle = vi.spyOn(api.storage, 'writeDocument').mockRejectedValue(new Error('Ambient write forbidden'))
    const handlers = configurationDomainHandlers(root, scoped)
    const call = async (method: keyof typeof configurationDomainSchemas, input: unknown = {}) => {
      const contract = commandContracts.find(entry => entry.method === `command.${method}`)!
      expect(contract, method).toBeDefined(); expect(contract.input(input), JSON.stringify(contract.input.errors)).toBe(true)
      return assertCommandOutput(`command.${method}`, input, await handlers[method](input)) as any
    }
    try {
      const profiles = await call('configuration.profiles')
      const profile = await call('configuration.profile', { id: 'default' })
      await call('configuration.profile.save', { personality: { ...profile.personality, name: 'Reviewed default' } })
      await call('configuration.profile.save', { personality: { id: 'temporary', configurationRevision: 0, name: 'Temporary', isDefault: false, instructions: 'Reviewed', routing: DEFAULT_ROUTING } })
      const temporary = await call('configuration.profile', { id: 'temporary' })
      await call('configuration.profile.delete', { id: 'temporary', expectedRevision: temporary.personality.configurationRevision })
      expect(profiles.personalities[0].configurationRevisions['settings.md']).toBeTypeOf('number')
      const commands = await call('configuration.commands')
      await call('configuration.commands.set', { commands: [{ name: 'review', prompt: 'Read the source.' }], expectedRevisions: commands.configurationRevisions })
      const channels = await call('configuration.channels')
      const saved = await call('configuration.channels.set', { connections: { bot: { type: 'telegram', name: 'Bot', allowFrom: [], enabled: false } }, expectedRevisions: channels.configurationRevisions })
      expect(saved.application).toEqual({ state: 'applied', connectionIds: [] })
      await call('configuration.rules')
      await call('configuration.rule.set', { name: 'review', content: 'Verify results.', expectedRevision: 0 })
      expect(scoped.storage.readDocument).toHaveBeenCalled(); expect(scoped.storage.writeDocuments).toHaveBeenCalled(); expect(scoped.storage.writeDocument).toHaveBeenCalled()
      expect(ambientRead).not.toHaveBeenCalled(); expect(ambientWrite).not.toHaveBeenCalled(); expect(ambientSingle).not.toHaveBeenCalled()
    } finally { ambientRead.mockRestore(); ambientWrite.mockRestore(); ambientSingle.mockRestore() }
  })

  it('admits one of ten stale command-list and channel saves without partial writes', async () => {
    const commands = await readCommandsSnapshot(root)
    const commandResults = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => saveCommands(root, [{ name: `review-${index}`, prompt: 'Read carefully.' }], commands.configurationRevisions)))
    expect(commandResults.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect((await readCommandsSnapshot(root)).commands).toHaveLength(1)
    const initial = await readChannelConfigurations(root, {})
    const revisions = channelConfigurationRevisions(initial)
    const channelResults = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => writeChannelConfigurations(root, { [`bot-${index}`]: { type: 'telegram', name: 'Bot', allowFrom: [], enabled: false } }, revisions)))
    expect(channelResults.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(Object.keys(await readChannelConfigurations(root, {}))).toHaveLength(1)
    for (const result of [...commandResults, ...channelResults]) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'REVISION_CONFLICT', outcome: 'not-applied' })
  })

  it('serializes reviewed default selection and refuses a stale profile deletion', async () => {
    const profiles = await listPersonalities(root), revisions = profiles[0].configurationRevisions
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => savePersonality(root, { id: `profile-${index}`, name: `Profile ${index}`, isDefault: true, routing: DEFAULT_ROUTING, instructions: 'Reviewed', configurationRevision: 0, configurationRevisions: revisions })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const current = await listPersonalities(root)
    expect(current.filter(profile => profile.isDefault)).toHaveLength(1)
    const selected = current.find(profile => profile.isDefault)!
    await savePersonality(root, { ...selected, instructions: 'Updated' })
    await expect(deletePersonality(root, selected.id, selected.configurationRevision!)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect((await readPersonality(root, selected.id))?.instructions).toBe('Updated')
  })

  it('keeps deleted profile tombstones authoritative without deleting unreviewed legacy files', async () => {
    await savePersonality(root, { id: 'legacy', name: 'Legacy', isDefault: false, routing: DEFAULT_ROUTING, instructions: 'Reviewed', configurationRevision: 0 })
    const file = configurationPath(root, 'personalities/legacy/profile.json')
    await fs.writeFile(file, JSON.stringify({ name: 'Legacy metadata edited externally' }))
    const profile = await readPersonality(root, 'legacy')
    await deletePersonality(root, 'legacy', profile!.configurationRevision!)
    expect(await readPersonality(root, 'legacy')).toBeNull()
    expect(await fs.readFile(file, 'utf8')).toContain('edited externally')
    expect((await readDocument(configurationPath(root, 'personalities/legacy/instructions.md'))).revision).toBeGreaterThan(profile!.configurationRevision!)
  })

  it('stops the old transport after commit and reports enabled restart as deferred', async () => {
    const stops = vi.fn(), channels: MessagingChannel[] = []
    channelManager.registerFactory('fixture', (id, name) => {
      const channel: MessagingChannel = { id, type: 'fixture', displayName: name, running: false, start() { channel.running = true }, stop() { stops(); channel.running = false }, async send() {} }
      channels.push(channel); return channel
    }, ['example.com'])
    const handlers = configurationDomainHandlers(root, backendApi())
    const initial = await handlers['configuration.channels']({}) as any
    const first = await handlers['configuration.channels.set']({ connections: { bot: { type: 'fixture', name: 'Bot', allowFrom: ['1'], enabled: false } }, expectedRevisions: initial.configurationRevisions }) as any
    channels[0].running = true
    const next = await handlers['configuration.channels.set']({ connections: { bot: { type: 'fixture', name: 'Renamed', allowFrom: ['2'], enabled: true } }, expectedRevisions: first.configurationRevisions }) as any
    assertCommandOutput('command.configuration.channels.set', {}, next)
    expect(stops).toHaveBeenCalledOnce(); expect(channels[0].running).toBe(false)
    expect(next.application).toMatchObject({ state: 'deferred', connectionIds: ['bot'], reason: expect.stringContaining('Restart is pending') })
    await expect(handlers['configuration.channels.set']({ connections: {}, expectedRevisions: first.configurationRevisions })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(stops).toHaveBeenCalledOnce()
  })
})
