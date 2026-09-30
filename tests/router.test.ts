import { describe, expect, it } from 'vitest'
import type { AiConnectionStatus, RoutingConfig } from '../src/types'
import { estimateComplexity, inferKind, route } from '../src/router'

const config: RoutingConfig = {
  auto: true,
  default: { provider: 'anthropic', model: 'claude-opus-4-8' },
  fast: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  rules: [
    { label: 'plan', kind: 'plan', provider: 'openai', model: 'gpt-5.1' },
    { label: 'code', kind: 'code', minComplexity: 3, provider: 'anthropic', model: 'claude-opus-4-8' }
  ]
}

describe('assistant router', () => {
  it('estimates higher complexity for long/code-heavy prompts', () => {
    expect(estimateComplexity('hi')).toBe(1)
    expect(estimateComplexity('refactor this function please '.repeat(10))).toBeGreaterThan(2)
    expect(estimateComplexity('```\ncode\n```')).toBeGreaterThanOrEqual(2)
  })

  it('infers task kind from cues', () => {
    expect(inferKind('plan the architecture')).toBe('plan')
    expect(inferKind('debug this typescript bug')).toBe('code')
    expect(inferKind('hi')).toBe('quick')
    expect(inferKind('tell me a story about the sea')).toBe('chat')
  })

  it('an explicit override always wins', () => {
    const r = route({ text: 'plan a big thing', override: { provider: 'gemini', model: 'gemini-2.5-pro' } }, config)
    expect(r).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-pro', reason: 'manual override' })
  })

  it('matches the first applicable rule by kind', () => {
    const r = route({ text: 'plan the migration strategy' }, config)
    expect(r).toMatchObject({ provider: 'openai', model: 'gpt-5.1' })
  })

  it('respects a rule minComplexity gate', () => {
    // "code" kind but trivially short → below minComplexity 3 → falls through to auto
    const r = route({ text: 'a bug' }, config)
    expect(r.model).not.toBe('claude-opus-4-8')
  })

  it('auto routes a simple turn to the fast model', () => {
    const r = route({ text: 'hi there' }, config)
    expect(r.provider).toBe('anthropic')
    expect(r.model).toBe('claude-haiku-4-5')
    expect(r.reason).toContain('fast')
  })

  it('auto routes a complex (long, rule-free) turn to the strong model', () => {
    // Long prose with no plan/code cues → no rule matches → auto picks strong.
    const r = route({ text: 'Tell me a long story about a cat who sails the seven seas and meets many friends. '.repeat(12) }, config)
    expect(r.model).toBe('claude-opus-4-8')
    expect(r.reason).toContain('strong')
  })

  it('with auto off, falls back to default when no rule matches', () => {
    const r = route({ text: 'random chit chat' }, { ...config, auto: false })
    expect(r).toMatchObject({ provider: 'anthropic', model: 'claude-opus-4-8', reason: 'default' })
  })

  it('falls back to a configured provider when the preferred one is not configured', () => {
    // Auto would pick anthropic/haiku, but only ollama is configured.
    const r = route({ text: 'hi there', configured: ['ollama'], modelFor: () => 'llama3' }, config)
    expect(r.provider).toBe('ollama')
    expect(r.model).toBe('llama3')
    expect(r.reason).toContain('fallback')
    expect(r.reason).toContain('anthropic')
  })

  it('prefers a configured provider already wired into routing on fallback', () => {
    // anthropic (default/fast) unconfigured; openai is a rule provider and is configured.
    const r = route({ text: 'hi there', configured: ['openai'] }, config)
    expect(r.provider).toBe('openai')
    expect(r.model).toBe('gpt-5.1')
    expect(r.reason).toContain('fallback')
  })

  it('leaves the pick unchanged when its provider is configured', () => {
    const r = route({ text: 'hi there', configured: ['anthropic', 'openai'] }, config)
    expect(r.provider).toBe('anthropic')
    expect(r.reason).not.toContain('fallback')
  })

  it('an override to an unconfigured provider does not fall back to Ollama', () => {
    const r = route(
      { text: 'anything', override: { provider: 'gemini', model: 'gemini-2.5-pro' }, configured: ['ollama'], modelFor: () => 'llama3' },
      config
    )
    expect(r).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-pro', reason: 'manual override' })
  })

  it('with an empty configured set, behaves exactly as before (no fallback)', () => {
    const r = route({ text: 'hi there', configured: [] }, config)
    expect(r.provider).toBe('anthropic')
    expect(r.reason).not.toContain('fallback')
  })
})


it('keeps exact connections distinct and applies the same availability rules to Auto', () => {
  const connections = [{ id: 'fern', provider: 'deepseek', configured: false, models: [{ id: 'deepseek-flash' }] },
    { id: 'moss', provider: 'deepseek', configured: true, models: [{ id: 'deepseek-flash' }] }] as AiConnectionStatus[]
  const config: RoutingConfig = { auto: true, default: { provider: 'deepseek', model: 'deepseek-flash', connectionId: 'fern' }, rules: [] }
  expect(() => route({ text: 'Fern', override: config.default, connections }, config)).toThrow('selected model connection is unavailable')
  expect(route({ text: 'Fern', connections }, config)).toMatchObject({ connectionId: 'moss' })
  expect(() => route({ text: 'Fern', connections: [] }, config)).toThrow('No configured models')
  expect(() => route({ text: 'Fern', connections, override: { ...config.default, connectionId: 'moss', model: 'missing' } }, config)).toThrow('unavailable')
})
