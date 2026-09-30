import { describe, expect, it, vi } from 'vitest'
import type { AiChatThread, AiPersonality, AssistantConfig, ChannelInfo, CustomCommand } from '../src/types'
import { dispatchConversationCommand, type ConversationCommandPorts } from '../src/backend/engine/commands'

function fixture() {
  const thread: AiChatThread = { id: 'remote', title: 'Field notes', createdAt: 1, updatedAt: 1, messages: [], source: 'telegram', channelId: 'bot', chatRef: '123' }
  const config = {
    routing: { auto: false, default: { provider: 'openai', model: 'test-model' }, rules: [] }, instructions: '', rules: [],
    providers: [{ provider: 'openai', configured: true, authMode: 'key', authSources: { envKey: false, savedKey: true }, baseUrl: '', models: [{ provider: 'openai', id: 'test-model', tools: true }] }],
    connections: [{ id: 'research', provider: 'openai', label: 'Research', providerName: 'OpenAI', providerDescription: '', providerIcon: '', providerCapabilities: ['chat'], requiresKey: true, baseUrl: '', createdAt: 1, configured: true, models: [{ provider: 'openai', id: 'test-model', tools: true }] }],
    guard: { defaultWrite: { decision: 'confirm', allowPreApproval: false }, tools: {}, commands: {}, files: { visitMode: 'allow-listed-only', defaultRead: { decision: 'allow' }, defaultWrite: { decision: 'confirm' }, allowedToVisit: ['**/*.md'], allowedToWrite: ['**/*.md'], blocked: ['.valley/assistant'], readOverrides: {}, writeOverrides: {} }, dangerousMode: { enabled: false, scope: 'off' }, pluginPresets: {} }
  } as AssistantConfig
  const overall: CustomCommand[] = [], profiles: AiPersonality[] = []
  const ports = {
    config: vi.fn(async () => config), commands: vi.fn(async () => overall), profiles: vi.fn(async () => profiles), guard: vi.fn(async () => ({ policy: config.guard })),
    update: vi.fn(async (patch: Parameters<ConversationCommandPorts['update']>[0]) => { Object.assign(thread, patch) }),
    clear: vi.fn(async () => { thread.messages = [] }), reply: vi.fn(async (_text: string) => {}), buttons: vi.fn(async (_text: string, _choices: Array<{ label: string; value: string }>) => {})
  }
  const dispatch = (text: string, callbackData?: string, channel?: ChannelInfo) => dispatchConversationCommand({ text, callbackData, thread, channel }, ports)
  return { thread, config, overall, profiles, ports, dispatch }
}

describe('backend conversation commands', () => {
  it('lists builtins and custom commands with the narrowest description, without model access', async () => {
    const f = fixture()
    f.overall.push({ name: 'note', description: 'Overall note', prompt: 'Overall' })
    f.thread.commands = [{ name: 'note', description: 'Chat note', prompt: 'Chat' }, { name: 'help', prompt: 'Override help' }]
    expect(await f.dispatch('/help')).toEqual({ handled: true })
    const text = f.ports.reply.mock.calls[0][0]
    expect(text).toContain('Commands:'); expect(text).toContain('/model'); expect(text).toContain('/note — Chat note')
    expect(text).not.toContain('Overall note'); expect(text).not.toContain('Override help')
    expect(f.ports.config).not.toHaveBeenCalled()
  })

  it('selects a discovered model with its exact configured connection and clears to Auto', async () => {
    const f = fixture()
    await f.dispatch('/model research:test-model')
    expect(f.thread.model).toEqual({ provider: 'openai', connectionId: 'research', model: 'test-model' })
    expect(f.ports.reply).toHaveBeenLastCalledWith('Model set to research:test-model.')
    await f.dispatch('/model auto')
    expect(f.thread.model).toBeNull()
    expect(f.ports.reply).toHaveBeenLastCalledWith('Model set to Auto.')
  })

  it('asks to disambiguate shared model IDs and rejects undiscovered or unconfigured models', async () => {
    const f = fixture()
    f.config.connections.push({ ...f.config.connections[0], id: 'work' })
    await f.dispatch('/model test-model')
    expect(f.ports.reply).toHaveBeenLastCalledWith(expect.stringContaining('pick one: research:test-model, work:test-model'))
    expect(f.thread.model).toBeUndefined()
    await f.dispatch('/model research:invented')
    expect(f.ports.reply).toHaveBeenLastCalledWith(expect.stringContaining('Unknown model'))
    f.config.connections[0].configured = false
    await f.dispatch('/model research:test-model')
    expect(f.ports.update).not.toHaveBeenCalled()
  })

  it('offers channel-compatible picker buttons and validates selections against current models', async () => {
    const f = fixture()
    await f.dispatch('/model')
    expect(f.ports.buttons).toHaveBeenCalledWith('Pick a connection:', [{ label: 'Research', value: 'mdlp:research' }])
    await f.dispatch('', 'mdlp:research')
    expect(f.ports.buttons).toHaveBeenLastCalledWith('Pick a model:', [{ label: 'test-model', value: 'mdls:research:test-model' }])
    await f.dispatch('', 'mdls:research:test-model')
    expect(f.thread.model).toMatchObject({ connectionId: 'research', model: 'test-model' })
    await f.dispatch('', 'mdls:research:removed')
    expect(f.ports.reply).toHaveBeenLastCalledWith(expect.stringContaining('Unknown model'))
  })

  it('sets profiles by ID or name and resets to the default', async () => {
    const f = fixture()
    f.profiles.push({ id: 'mycology', name: 'Mycology', isDefault: false, instructions: '', routing: f.config.routing })
    await f.dispatch('/profile Mycology')
    expect(f.thread.profileId).toBe('mycology')
    expect(f.ports.reply).toHaveBeenLastCalledWith('Personality set to Mycology.')
    await f.dispatch('/profile default')
    expect(f.thread.profileId).toBeUndefined()
  })

  it('reports guard policy without granting permissions', async () => {
    const f = fixture()
    await f.dispatch('/guard')
    expect(f.ports.reply).toHaveBeenLastCalledWith(expect.stringContaining('File access: allow-listed only'))
    expect(f.ports.reply.mock.calls[0][0]).toContain('Dangerous mode: off')
    expect(f.ports.update).not.toHaveBeenCalled()
  })

  it('handles clear and unknown commands offline without an inference turn', async () => {
    const f = fixture()
    f.config.connections = []; f.config.providers = []
    f.thread.messages = [{ role: 'user', content: 'Old context' }]
    expect(await f.dispatch('/clear')).toEqual({ handled: true })
    expect(f.ports.clear).toHaveBeenCalledOnce()
    expect(f.thread.messages).toEqual([])
    expect(f.ports.reply).toHaveBeenLastCalledWith(expect.stringContaining('saved memory kept'))
    expect(await f.dispatch('/wat')).toEqual({ handled: true })
    expect(f.ports.reply).toHaveBeenLastCalledWith('Unknown command /wat. Send /help for the list.')
    expect(f.ports.config).not.toHaveBeenCalled()
  })

  it('expands custom commands with chat then connection then global precedence', async () => {
    const f = fixture()
    f.overall.push({ name: 'note', prompt: 'Overall note' })
    const channel = { type: 'telegram', commands: [{ name: 'note', prompt: 'Channel note: {args}' }] } as ChannelInfo
    expect(await f.dispatch('/note record moss', undefined, channel)).toEqual({ handled: false, text: 'Channel note: record moss' })
    f.thread.commands = [{ name: 'note', prompt: 'Chat note: {args}' }]
    expect(await f.dispatch('/note record moss', undefined, channel)).toEqual({ handled: false, text: 'Chat note: record moss' })
    f.thread.commands = []
    expect(await f.dispatch('/note record moss')).toEqual({ handled: false, text: 'Overall note\n\nrecord moss' })
    expect(f.ports.reply).not.toHaveBeenCalled()
  })

  it('never converts typed YES or old approval callback data into plan approval', async () => {
    const f = fixture()
    f.thread.mode = 'plan'; f.thread.plan = { id: 'plan', revision: 1, text: 'Plan', status: 'review' }
    expect(await f.dispatch('YES')).toEqual({ handled: false, text: 'YES' })
    expect(await f.dispatch('', 'allow:old-request')).toEqual({ handled: true })
    expect(f.ports.reply).toHaveBeenLastCalledWith(expect.stringContaining('unavailable or has expired'))
    expect(f.thread.mode).toBe('plan'); expect(f.thread.plan.status).toBe('review')
    expect(f.ports.update).not.toHaveBeenCalled()
  })

  it('uses the same dispatcher for local commands without needing a channel', async () => {
    const f = fixture()
    delete f.thread.source; delete f.thread.channelId; delete f.thread.chatRef
    f.overall.push({ name: 'survey', prompt: 'Plan the habitat survey.' })
    expect(await f.dispatch('/model research:test-model')).toEqual({ handled: true })
    expect(f.thread.model).toMatchObject({ connectionId: 'research' })
    expect(await f.dispatch('/survey')).toEqual({ handled: false, text: 'Plan the habitat survey.' })
  })
})
