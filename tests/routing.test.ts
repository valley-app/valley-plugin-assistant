import { describe, expect, it } from 'vitest'
import type { AiConnectionStatus, RoutingConfig } from '../src/types'
import { resolveRouting, route } from '../src/router'
import { parseModelValue } from '../src/models'

/**
 * Routing precedence (C7): the old hard-coded channel→OpenAI-cheap branch is gone.
 * The effective routing is chat → channel → personality → global default; a per-chat
 * *model* override (route's `input.override`) is more specific still and wins over all.
 */
const base: RoutingConfig = { auto: false, default: { provider: 'anthropic', model: 'claude-opus-4-8' }, rules: [] }
const chat: RoutingConfig = { auto: false, default: { provider: 'openai', model: 'gpt-5.5' }, rules: [] }
const channel: RoutingConfig = { auto: false, default: { provider: 'deepseek', model: 'deepseek-v4-flash' }, rules: [] }
const profile: RoutingConfig = { auto: false, default: { provider: 'kimi', model: 'kimi-k2' }, rules: [] }

describe('routing precedence', () => {
  it('resolves model selections only through an existing connection', () => {
    const connections = [{ id: 'research', provider: 'openai' }] as AiConnectionStatus[]
    expect(parseModelValue('research:model:variant', connections)).toEqual({
      provider: 'openai', model: 'model:variant', connectionId: 'research'
    })
    expect(parseModelValue('openai:model', connections)).toBeNull()
    expect(parseModelValue('research:', connections)).toBeNull()
  })

  it('returns the global default when no layers are present', () => {
    expect(resolveRouting(base, {})).toBe(base)
    expect(resolveRouting(base)).toBe(base)
  })

  it('prefers chat → channel → personality, in that order', () => {
    expect(resolveRouting(base, { chat })).toBe(chat)
    expect(resolveRouting(base, { channel })).toBe(channel)
    expect(resolveRouting(base, { profile })).toBe(profile)
    expect(resolveRouting(base, { chat, channel, profile })).toBe(chat)
    expect(resolveRouting(base, { channel, profile })).toBe(channel)
  })

  it('ignores null/undefined layers (falls through to the next)', () => {
    expect(resolveRouting(base, { chat: null, channel })).toBe(channel)
    expect(resolveRouting(base, { chat: undefined, channel: null, profile })).toBe(profile)
  })

  it('a channel turn is NOT forced onto an OpenAI-cheap model (C7)', () => {
    // With no per-channel routing layer, a channel turn uses the global default —
    // exactly like an in-app turn would.
    const routed = route({ text: 'hi' }, resolveRouting(base, { channel: null }))
    expect(routed).toMatchObject({ provider: 'anthropic', model: 'claude-opus-4-8' })
  })

  it('an explicit per-chat model override beats every routing layer', () => {
    const routed = route({ text: 'hi', override: { provider: 'openai', model: 'gpt-4o' } }, resolveRouting(base, { chat }))
    expect(routed).toMatchObject({ provider: 'openai', model: 'gpt-4o', reason: 'manual override' })
  })

  it('Auto fallback still applies through the resolved routing', () => {
    const autoBase: RoutingConfig = {
      auto: true,
      default: { provider: 'anthropic', model: 'claude-opus-4-8' },
      fast: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      rules: []
    }
    const quick = route({ text: 'hi' }, resolveRouting(autoBase, {}))
    expect(quick.model).toBe('claude-haiku-4-5') // simple turn → fast
    const hard = route({ text: 'Design a distributed architecture with trade-offs '.repeat(10), toolDepth: 3 }, resolveRouting(autoBase, {}))
    expect(hard.model).toBe('claude-opus-4-8') // complex → strong
  })
})
