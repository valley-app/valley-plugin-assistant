import type { AiConnectionStatus, AiProviderId, RoutingConfig, RoutingRule } from './types'

/**
 * The model router — "Mother of the orchestra". Pure and unit-tested. Runs in
 * the plugin (the agent loop lives here), deciding which model plays each part
 * before calling `drivers.ai.chat`.
 *
 * Precedence: an explicit per-chat override always wins. Otherwise the first
 * matching user rule (by keyword / task kind / minimum complexity) decides. If
 * nothing matches and Auto is on, the cheap `fast` model handles simple turns
 * and the strong `default` handles complex ones. With Auto off, `default` wins.
 */
/**
 * The routing layers that narrow which `RoutingConfig` a turn uses (C7). The
 * effective routing is the first present of: per-chat routing override → channel
 * default routing → personality routing → the global default (`config.routing`).
 * A per-chat *model* override is handled separately and more specifically by
 * `route()`'s `input.override`, so it still wins over all of these. Channel and
 * personality layers are populated in later phases; until then this returns the
 * global routing — which crucially is **no longer** the hard-coded OpenAI-cheap
 * config that channel turns used to be forced onto.
 */
export interface RoutingLayers {
  chat?: RoutingConfig | null
  channel?: RoutingConfig | null
  profile?: RoutingConfig | null
}

export function resolveRouting(base: RoutingConfig, layers: RoutingLayers = {}): RoutingConfig {
  return layers.chat ?? layers.channel ?? layers.profile ?? base
}

export interface RouteInput {
  connections?: AiConnectionStatus[]
  text: string
  kind?: string
  toolDepth?: number
  override?: { provider: AiProviderId; model: string; connectionId?: string } | null
  /**
   * Providers that currently hold a usable credential (key or OAuth). When
   * non-empty, the router refuses to route to a provider outside this set and
   * falls back to the best configured one for automatic routing — so the
   * assistant still works when only some providers are set up. Manual overrides
   * bypass this fallback. Empty/omitted = behave as before.
   */
  configured?: AiProviderId[]
  /** First known model id for a provider — used to pick a model on fallback. */
  modelFor?: (provider: AiProviderId) => string | undefined
}

export interface RouteResult {
  provider: AiProviderId
  model: string
  /** Which of the provider's connections to bill and authenticate against.
   *  Absent means the provider's default connection. */
  connectionId?: string
  reason: string
}

const CODE_CUES = /\b(code|coding|refactor|debug|stack ?trace|implement|function|bug|compile|typescript|python|regex)\b/i
const PLAN_CUES = /\b(plan|design|architect|architecture|strategy|break down|decompose|think through|roadmap|trade-?offs?)\b/i
const QUICK_CUES = /\b(hi|hey|hello|thanks|thank you|what'?s|when|where|who|define)\b/i

/** Estimate task complexity on a 1–5 scale from the message shape. */
export function estimateComplexity(text: string, toolDepth = 0): number {
  let score = 1
  const len = text.trim().length
  if (len > 120) score += 1
  if (len > 600) score += 1
  if (/```/.test(text)) score += 1
  if (PLAN_CUES.test(text) || CODE_CUES.test(text)) score += 1
  if (toolDepth >= 2) score += 1
  return Math.max(1, Math.min(5, score))
}

/** Infer a coarse task kind when the caller didn't supply one. */
export function inferKind(text: string): string {
  if (PLAN_CUES.test(text)) return 'plan'
  if (CODE_CUES.test(text)) return 'code'
  if (text.trim().length <= 80 && QUICK_CUES.test(text)) return 'quick'
  return 'chat'
}

function ruleMatches(rule: RoutingRule, kind: string, complexity: number, text: string): boolean {
  if (rule.kind && rule.kind !== kind) return false
  if (typeof rule.minComplexity === 'number' && complexity < rule.minComplexity) return false
  if (rule.match?.length) {
    const lower = text.toLowerCase()
    if (!rule.match.some((m) => lower.includes(m.toLowerCase()))) return false
  }
  return true
}

function pick(input: RouteInput, config: RoutingConfig): RouteResult {
  if (input.override) {
    return { provider: input.override.provider, model: input.override.model, connectionId: input.override.connectionId, reason: 'manual override' }
  }
  const kind = input.kind ?? inferKind(input.text)
  const complexity = estimateComplexity(input.text, input.toolDepth)

  for (const rule of config.rules ?? []) {
    if (ruleMatches(rule, kind, complexity, input.text)) {
      return { provider: rule.provider, model: rule.model, connectionId: rule.connectionId, reason: `rule: ${rule.label ?? rule.kind ?? 'match'}` }
    }
  }

  if (config.auto && config.fast && complexity <= 2 && (input.toolDepth ?? 0) < 2) {
    return { provider: config.fast.provider, model: config.fast.model, connectionId: config.fast.connectionId, reason: `auto · fast (complexity ${complexity})` }
  }
  return {
    provider: config.default.provider,
    model: config.default.model,
    connectionId: config.default.connectionId,
    reason: config.auto ? `auto · strong (complexity ${complexity})` : 'default'
  }
}

/**
 * Pick a provider/model. A manual override is exact. Otherwise, when
 * `input.configured` is non-empty and the natural pick's provider isn't in it,
 * fall back — in order — to the default/fast model whose provider is configured,
 * the first matching rule's configured provider, or simply the first configured
 * provider (keeping the picked model only when the provider is unchanged). This
 * is what lets Auto "do its best with the existing one" instead of failing on an
 * unconfigured default.
 */
export function route(input: RouteInput, config: RoutingConfig): RouteResult {
  const chosen = pick(input, config)
  if (input.connections) {
    const available = input.connections.filter(connection => connection.configured && connection.models.length)
    const resolve = (model: { provider: string; model: string; connectionId?: string }) => {
      const connection = available.find(connection => connection.provider === model.provider && connection.id === (model.connectionId ?? model.provider))
      return connection?.models.some(candidate => candidate.id === model.model) ? { ...model, connectionId: connection.id } : null
    }
    const exact = resolve(chosen)
    if (exact) return { ...exact, reason: chosen.reason }
    if (input.override) throw new Error('The selected model connection is unavailable. Choose a configured model in Settings.')
    const candidates = [config.default, ...(config.fast ? [config.fast] : []), ...(config.rules ?? [])]
    const fallback = candidates.map(resolve).find(Boolean)
    if (fallback) return { ...fallback, reason: 'configured connection fallback' }
    const first = available[0]
    if (first) return { provider: first.provider, model: first.models[0].id, connectionId: first.id, reason: 'configured connection fallback' }
    throw new Error('No configured models are available. Add an AI connection in Settings.')
  }
  if (input.override) return chosen
  const configured = input.configured
  if (!configured?.length || configured.includes(chosen.provider)) return chosen

  const ok = (p: AiProviderId): boolean => configured.includes(p)
  const modelFor = input.modelFor ?? (() => undefined)

  // Prefer a configured candidate that the user already wired into routing.
  const candidates: { provider: AiProviderId; model: string; connectionId?: string }[] = [
    config.default,
    ...(config.fast ? [config.fast] : []),
    ...(config.rules ?? []).map((r) => ({ provider: r.provider, model: r.model, connectionId: r.connectionId }))
  ]
  const wired = candidates.find((c) => ok(c.provider))
  if (wired) {
    return { provider: wired.provider, model: wired.model, connectionId: wired.connectionId, reason: `fallback · ${chosen.provider} not configured → ${wired.provider}` }
  }

  // Otherwise fall back to any configured provider, picking its first model. No
  // connection is named — main resolves the provider's default one.
  const provider = configured[0]
  const model = modelFor(provider) ?? chosen.model
  return { provider, model, reason: `fallback · ${chosen.provider} not configured → ${provider}` }
}
