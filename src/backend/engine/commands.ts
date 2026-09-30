import type { GuardOverrides, GuardPolicy } from '@valley/plugin-sdk/guard/types'
import type { AiChatThread, AiPersonality, AssistantConfig, ChannelInfo, CustomCommand } from '../../types'
import { expandCommand, helpText, isBuiltinCommand, parseCommand, parseModelPickerCallback, resolveCustomCommand } from '../../channelCommands'

export interface ConversationCommandPorts {
  config(): Promise<AssistantConfig>
  commands(): Promise<CustomCommand[]>
  profiles(): Promise<AiPersonality[]>
  guard(): Promise<{ policy: GuardPolicy; overrides?: GuardOverrides | null }>
  update(patch: Pick<Partial<AiChatThread>, 'model' | 'profileId'>): Promise<void>
  clear(): Promise<void>
  reply(text: string): Promise<void>
  buttons?(text: string, choices: Array<{ label: string; value: string }>): Promise<void>
}
export interface ConversationCommandInput { text: string; callbackData?: string; thread: AiChatThread; channel?: ChannelInfo }
export type ConversationCommandResult = { handled: true } | { handled: false; text: string }

export async function dispatchConversationCommand(input: ConversationCommandInput, ports: ConversationCommandPorts): Promise<ConversationCommandResult> {
  const parsed = parseCommand(input.text), callback = input.callbackData ? parseModelPickerCallback(input.callbackData) : null
  if (!parsed && !input.callbackData) return { handled: false, text: input.text }
  if (input.callbackData && !callback) { await ports.reply('This action is unavailable or has expired. Use the current buttons or /help.'); return { handled: true } }
  const cmd = callback ? 'model' : parsed!.cmd, arg = callback?.kind === 'set' ? `${callback.provider}:${callback.model}` : parsed?.arg ?? ''
  const sendChoices = async (label: string, choices: Array<{ label: string; value: string }>) => {
    const max = input.channel?.type === 'whatsapp' ? 3 : 20
    const eligible = choices.filter(choice => new TextEncoder().encode(choice.value).length <= 64 && choice.label.length <= (input.channel?.type === 'whatsapp' ? 20 : 256))
    if (ports.buttons && eligible.length) await ports.buttons(label, eligible.slice(0, max))
  }
  if (!isBuiltinCommand(cmd)) {
    const custom = resolveCustomCommand(cmd, { chat: input.thread.commands, channel: input.channel?.commands, overall: await ports.commands() })
    if (custom) return { handled: false, text: expandCommand(custom, arg) }
    await ports.reply(`Unknown command /${cmd}. Send /help for the list.`)
    return { handled: true }
  }
  if (cmd === 'clear' || cmd === 'reset') {
    await ports.clear(); await ports.reply('Conversation cleared (saved memory kept). Starting fresh.')
  } else if (cmd === 'help') {
    const custom = new Map<string, CustomCommand>()
    for (const item of [...await ports.commands(), ...(input.channel?.commands ?? []), ...(input.thread.commands ?? [])]) if (!isBuiltinCommand(item.name)) custom.set(item.name.toLowerCase(), item)
    await ports.reply(helpText() + (custom.size ? `\n\nCustom commands:\n${[...custom.values()].map(item => `/${item.name}${item.description ? ` — ${item.description}` : ''}`).join('\n')}` : ''))
  } else if (cmd === 'profile') {
    if (!arg) await ports.reply(`Personality: ${input.thread.profileId ?? 'default'}`)
    else if (/^(default|none|reset|clear)$/i.test(arg)) { await ports.update({ profileId: undefined }); await ports.reply('Personality set to default.') }
    else {
      const profiles = await ports.profiles(), selected = profiles.find(profile => [profile.id, profile.name].some(value => value.toLowerCase() === arg.toLowerCase()))
      if (!selected) await ports.reply(`No personality "${arg}". Available: ${profiles.map(profile => profile.id).join(', ') || 'default'}`)
      else { await ports.update({ profileId: selected.isDefault ? undefined : selected.id }); await ports.reply(`Personality set to ${selected.name}.`) }
    }
  } else if (cmd === 'guard') {
    const { policy, overrides } = await ports.guard()
    const count = Object.keys(overrides?.tools ?? {}).length + Object.keys(overrides?.commands ?? {}).length + Object.keys(overrides?.fileReadOverrides ?? {}).length + Object.keys(overrides?.fileWriteOverrides ?? {}).length + (overrides?.blocked?.length ?? 0)
    await ports.reply(['Guard policy for this chat:', `- Writes: ${policy.defaultWrite.decision}`, `- File access: ${policy.files.visitMode === 'allow-listed-only' ? 'allow-listed only' : 'all except blocked'}`, `- Dangerous mode: ${policy.dangerousMode.enabled ? 'on' : 'off'}`, `- Per-chat overrides: ${count}`].join('\n'))
  } else if (cmd === 'model') {
    const config = await ports.config(), connections = config.connections.filter(connection => connection.configured)
    const models = connections.flatMap(connection => connection.models.map(model => ({ provider: connection.provider, connectionId: connection.id, model: model.id })))
    if (callback?.kind === 'provider') {
      const choices = models.filter(model => model.connectionId === callback.provider || model.provider === callback.provider)
      await ports.reply(choices.length ? `Available models: ${choices.map(model => `${model.connectionId}:${model.model}`).join(', ')}` : 'No configured models are available for that connection.')
      await sendChoices('Pick a model:', choices.map(model => ({ label: model.model, value: `mdls:${model.connectionId}:${model.model}` })))
    } else if (!arg) {
      await ports.reply(`Model: ${input.thread.model ? `${input.thread.model.connectionId ?? input.thread.model.provider}:${input.thread.model.model}` : 'Auto'}`)
      await sendChoices('Pick a connection:', connections.filter(connection => connection.models.length).map(connection => ({ label: connection.label || connection.provider, value: `mdlp:${connection.id}` })))
    } else if (/^(auto|default|reset|off|clear|none)$/i.test(arg)) { await ports.update({ model: null }); await ports.reply('Model set to Auto.') }
    else {
      const colon = arg.indexOf(':'), scope = colon < 0 ? null : arg.slice(0, colon).toLowerCase(), query = (colon < 0 ? arg : arg.slice(colon + 1)).toLowerCase()
      const exactConnection = connections.some(connection => connection.id.toLowerCase() === scope)
      const candidates = models.filter(model => model.model.toLowerCase() === query && (!scope || (exactConnection ? model.connectionId.toLowerCase() === scope : model.provider.toLowerCase() === scope)))
      if (!candidates.length) await ports.reply(`Unknown model "${arg}". Try /model auto, a discovered model ID, or connection:model.`)
      else if (candidates.length > 1) await ports.reply(`Several connections offer that model — pick one: ${candidates.map(model => `${model.connectionId}:${model.model}`).join(', ')}`)
      else { await ports.update({ model: candidates[0] }); await ports.reply(`Model set to ${candidates[0].connectionId}:${candidates[0].model}.`) }
    }
  }
  return { handled: true }
}
