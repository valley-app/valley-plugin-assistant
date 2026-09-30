import { describe, expect, it } from 'vitest'
import type { AiProviderStatus, CustomCommand } from '../src/types'
import {
  approvalButtons,
  expandCommand,
  isBuiltinCommand,
  modelPickerButtons,
  parseCallbackData,
  parseCommand,
  parseModelArg,
  parseModelPickerCallback,
  providerPickerButtons,
  resolveCustomCommand
} from '../src/channelCommands'

/**
 * Remote slash-command parsing (spec §7.1): `/command arg` splitting and the
 * `/model` value form — `provider:model`, a bare id resolved against configured
 * providers, and a disambiguation prompt when several providers expose the same id.
 */
const provider = (id: AiProviderStatus['provider'], models: string[]): AiProviderStatus => ({
  provider: id,
  configured: true,
  authMode: 'key',
  authSources: { envKey: false, savedKey: true },
  baseUrl: '',
  models: models.map((m) => ({ provider: id, id: m, tools: true }))
})

describe('parseCommand', () => {
  it('splits a leading-slash command and its argument', () => {
    expect(parseCommand('/model claude-opus-4-8')).toEqual({ cmd: 'model', arg: 'claude-opus-4-8' })
    expect(parseCommand('/help')).toEqual({ cmd: 'help', arg: '' })
    expect(parseCommand('  /Clear  ')).toEqual({ cmd: 'clear', arg: '' })
    expect(parseCommand('/profile  mycology bot ')).toEqual({ cmd: 'profile', arg: 'mycology bot' })
  })

  it('returns null for non-commands', () => {
    expect(parseCommand('hello there')).toBeNull()
    expect(parseCommand('what is /etc/hosts')).toBeNull()
    expect(parseCommand('/')).toBeNull()
  })
})

describe('parseModelArg', () => {
  const providers = [provider('anthropic', ['claude-opus-4-8']), provider('openai', ['gpt-5.5', 'shared-model']), provider('deepseek', ['shared-model'])]

  it('treats auto/default/empty as a clear', () => {
    expect(parseModelArg('', providers)).toEqual({ kind: 'clear' })
    expect(parseModelArg('auto', providers)).toEqual({ kind: 'clear' })
    expect(parseModelArg('  Default ', providers)).toEqual({ kind: 'clear' })
  })

  it('accepts an explicit provider:model (model taken as-is)', () => {
    expect(parseModelArg('openai:gpt-5.5', providers)).toEqual({ kind: 'set', model: { provider: 'openai', model: 'gpt-5.5' } })
    // A brand-new id the seeded list doesn't know is still accepted.
    expect(parseModelArg('anthropic:claude-next', providers)).toEqual({ kind: 'set', model: { provider: 'anthropic', model: 'claude-next' } })
  })

  it('rejects an unknown provider prefix or empty model', () => {
    expect(parseModelArg('nope:x', providers)).toEqual({ kind: 'unknown', query: 'nope:x' })
    expect(parseModelArg('openai:', providers)).toEqual({ kind: 'unknown', query: 'openai:' })
  })

  it('resolves a bare id on exactly one provider', () => {
    expect(parseModelArg('claude-opus-4-8', providers)).toEqual({ kind: 'set', model: { provider: 'anthropic', model: 'claude-opus-4-8' } })
    expect(parseModelArg('GPT-5.5', providers)).toEqual({ kind: 'set', model: { provider: 'openai', model: 'gpt-5.5' } })
  })

  it('asks to disambiguate a bare id offered by several providers', () => {
    const res = parseModelArg('shared-model', providers)
    expect(res.kind).toBe('ambiguous')
    if (res.kind === 'ambiguous') {
      expect(res.candidates).toEqual([
        { provider: 'openai', model: 'shared-model' },
        { provider: 'deepseek', model: 'shared-model' }
      ])
    }
  })

  it('reports an unknown bare id', () => {
    expect(parseModelArg('made-up', providers)).toEqual({ kind: 'unknown', query: 'made-up' })
  })
})

describe('custom command resolution', () => {
  const cmd = (name: string, prompt: string): CustomCommand => ({ name, prompt })

  it('knows the built-in control commands (never shadowable)', () => {
    for (const b of ['help', 'clear', 'reset', 'model', 'profile', 'guard']) expect(isBuiltinCommand(b)).toBe(true)
    expect(isBuiltinCommand('CLEAR')).toBe(true)
    expect(isBuiltinCommand('fieldlog')).toBe(false)
  })

  it('resolves narrowest-scope-wins: chat → channel → overall', () => {
    const overall = [cmd('fieldlog', 'overall field log'), cmd('brief', 'overall brief')]
    const channel = [cmd('fieldlog', 'channel field log')]
    const chat = [cmd('fieldlog', 'chat field log')]
    expect(resolveCustomCommand('fieldlog', { chat, channel, overall })?.prompt).toBe('chat field log')
    expect(resolveCustomCommand('fieldlog', { channel, overall })?.prompt).toBe('channel field log')
    expect(resolveCustomCommand('fieldlog', { overall })?.prompt).toBe('overall field log')
    // A command only defined overall still resolves when narrower scopes lack it.
    expect(resolveCustomCommand('brief', { chat, channel, overall })?.prompt).toBe('overall brief')
    expect(resolveCustomCommand('missing', { chat, channel, overall })).toBeNull()
    expect(resolveCustomCommand('FIELDLOG', { chat })?.prompt).toBe('chat field log') // case-insensitive
  })

  it('expands {args}, else appends the trailing text', () => {
    expect(expandCommand(cmd('identify', 'Identify {args}.'), 'Fern')).toBe('Identify Fern.')
    expect(expandCommand(cmd('track', 'Track {args}, then {args}.'), 'Fox')).toBe('Track Fox, then Fox.')
    expect(expandCommand(cmd('summarize', 'Summarize the habitat survey.'), 'extra detail')).toBe('Summarize the habitat survey.\n\nextra detail')
    expect(expandCommand(cmd('summarize', 'Summarize the habitat survey.'), '')).toBe('Summarize the habitat survey.')
    expect(expandCommand(cmd('blank', 'Fill {args} here.'), '')).toBe('Fill  here.')
  })
})

describe('approval callback protocol (C9)', () => {
  it('parses <action>:<requestId> and rejects junk', () => {
    expect(parseCallbackData('allow:r123')).toEqual({ action: 'allow', requestId: 'r123' })
    expect(parseCallbackData('block:r9')).toEqual({ action: 'block', requestId: 'r9' })
    expect(parseCallbackData('yes')).toBeNull() // legacy/no colon
    expect(parseCallbackData('frob:r1')).toBeNull() // unknown action
    expect(parseCallbackData('allow:')).toBeNull() // empty id
  })

  it('builds buttons that stay under the 64-byte limit; remember only when allowed', () => {
    const without = approvalButtons('r1234567890', false)
    expect(without.map((b) => b.value)).toEqual(['allow:r1234567890', 'skip:r1234567890', 'aask:r1234567890', 'block:r1234567890'])
    const withRemember = approvalButtons('r1234567890', true)
    expect(withRemember.some((b) => b.value.startsWith('aallow:'))).toBe(true)
    expect([...without, ...withRemember].every((b) => b.value.length <= 64)).toBe(true)
  })
})

describe('/model inline button picker', () => {
  it('offers every dynamically discovered provider', () => {
    expect(providerPickerButtons([
      provider('community-ai', ['community-model']),
      provider('ollama', ['llama3.1'])
    ])).toEqual([
      { label: 'Community-ai', value: 'mdlp:community-ai' },
      { label: 'Ollama', value: 'mdlp:ollama' }
    ])
  })

  it('lists a provider\'s seeded models for the second step', () => {
    const providers = [provider('ollama', ['llama3.1', 'qwen2.5']), provider('deepseek', ['deepseek-v4-flash'])]
    expect(modelPickerButtons('ollama', providers)).toEqual([
      { label: 'llama3.1', value: 'mdls:ollama:llama3.1' },
      { label: 'qwen2.5', value: 'mdls:ollama:qwen2.5' }
    ])
    expect(modelPickerButtons('kimi', providers)).toEqual([])
  })

  it('round-trips mdlp:/mdls: callback values and rejects everything else', () => {
    expect(parseModelPickerCallback('mdlp:deepseek')).toEqual({ kind: 'provider', provider: 'deepseek' })
    expect(parseModelPickerCallback('mdls:deepseek:deepseek-v4-flash')).toEqual({ kind: 'set', provider: 'deepseek', model: 'deepseek-v4-flash' })
    expect(parseModelPickerCallback('allow:r123')).toBeNull() // approval protocol, not the model picker
    expect(parseModelPickerCallback('mdlp:')).toBeNull()
    expect(parseModelPickerCallback('mdls:deepseek:')).toBeNull()
    expect(parseModelPickerCallback('mdls:deepseek')).toBeNull()
  })
})
