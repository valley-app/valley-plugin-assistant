import type { AiProviderId } from '../types'

/**
 * Per-model token pricing (USD per 1,000,000 tokens) used to turn the token
 * counts streamed by each provider into a dollar cost. The table lives in code
 * (never in the vault) so the cost basis can't be edited to forge the spend
 * numbers. Matched by longest model-id prefix so dated/aliased ids still hit;
 * an unknown model costs $0 but its tokens are still counted (never throws).
 *
 * Anthropic figures are the current published rates; other cloud providers use
 * representative published list prices and can be refined later. Ollama is local
 * and OpenAI Codex subscription usage is not Platform API billing, so both are
 * counted as $0 here.
 */
interface Rate {
  /** USD per 1M input tokens. */
  in: number
  /** USD per 1M output tokens. */
  out: number
}

const MILLION = 1_000_000

// Keyed by `${provider}:${modelIdPrefix}`. Longest matching prefix wins.
const TABLE: Record<string, Rate> = {
  // Anthropic (verified, USD / 1M tokens)
  'anthropic:claude-fable-5': { in: 10, out: 50 },
  'anthropic:claude-opus-4': { in: 5, out: 25 },
  'anthropic:claude-sonnet-4': { in: 3, out: 15 },
  'anthropic:claude-haiku-4': { in: 1, out: 5 },
  'anthropic:claude-3-5-haiku': { in: 1, out: 5 },
  'anthropic:claude-3-haiku': { in: 0.25, out: 1.25 },
  // OpenAI (representative list prices)
  'openai:gpt-4.1-nano': { in: 0.1, out: 0.4 },
  'openai:gpt-5.4-nano': { in: 0.2, out: 1.25 },
  'openai:gpt-5': { in: 1.25, out: 10 },
  'openai:gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'openai:gpt-4.1': { in: 2, out: 8 },
  'openai:gpt-4o-mini': { in: 0.15, out: 0.6 },
  'openai:gpt-4o': { in: 2.5, out: 10 },
  'openai:o4-mini': { in: 1.1, out: 4.4 },
  'openai:o3': { in: 2, out: 8 },
  // Google Gemini
  'gemini:gemini-2.5-pro': { in: 1.25, out: 10 },
  'gemini:gemini-2.5-flash': { in: 0.3, out: 2.5 },
  'gemini:gemini-2.0-flash': { in: 0.1, out: 0.4 },
  'gemini:gemini-1.5-pro': { in: 1.25, out: 5 },
  'gemini:gemini-1.5-flash': { in: 0.075, out: 0.3 },
  // DeepSeek (cache-miss input rates)
  'deepseek:deepseek-v4-pro': { in: 0.435, out: 0.87 },
  'deepseek:deepseek-v4-flash': { in: 0.14, out: 0.28 },
  // Retired 2026-07-24 — kept so historical usage rows still price out.
  'deepseek:deepseek-reasoner': { in: 0.55, out: 2.19 },
  'deepseek:deepseek-chat': { in: 0.27, out: 1.1 },
  // Moonshot / Kimi
  'kimi:moonshot-v1': { in: 0.6, out: 2.5 },
  'kimi:kimi': { in: 0.6, out: 2.5 },
  // xAI / Grok
  'xai:grok-4': { in: 3, out: 15 },
  'xai:grok-3-mini': { in: 0.3, out: 0.5 },
  'xai:grok-3': { in: 3, out: 15 }
}

function rateFor(provider: AiProviderId, model: string): Rate {
  // Ollama runs locally — not billed per token, so it costs $0 here (tokens still counted).
  if (provider === 'ollama') {
    return { in: 0, out: 0 }
  }
  const candidates = Object.keys(TABLE)
    .filter((key) => key.startsWith(`${provider}:`) && `${provider}:${model}`.startsWith(key))
    .sort((a, b) => b.length - a.length)
  return candidates[0] ? TABLE[candidates[0]] : { in: 0, out: 0 }
}

/** Cost in USD for one call. Unknown models cost $0 (tokens are still tracked elsewhere). */
export function costFor(provider: AiProviderId, model: string, inputTokens: number, outputTokens: number): number {
  const rate = rateFor(provider, model)
  return (Math.max(0, inputTokens) * rate.in + Math.max(0, outputTokens) * rate.out) / MILLION
}
