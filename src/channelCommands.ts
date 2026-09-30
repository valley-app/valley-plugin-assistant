import type { AiProviderId, AiProviderStatus, CustomCommand } from './types'
import { capitalize } from '@valley/plugin-sdk/normalize'
import { uiText } from './localization'

/**
 * Pure parsing for the assistant's remote slash-commands (`/model`, `/profile`,
 * `/clear`, `/guard`, `/help`) sent over a channel (Telegram first). Kept free of
 * the store + SDK so it is exhaustively unit-tested; the store wires the parsed
 * intent to the live config/thread. See docs/architecture/ASSISTANT.md §Channels.
 */

export interface ModelRef {
  provider: AiProviderId
  model: string
}

/** One parsed `/command arg` (leading slash stripped; `cmd` lower-cased). */
export interface ParsedCommand {
  cmd: string
  arg: string
}

/** Split a leading-slash message into `{ cmd, arg }`, or null when it isn't a command. */
export function parseCommand(text: string): ParsedCommand | null {
  const t = text.trim()
  if (!t.startsWith('/')) return null
  const m = /^\/([a-z][a-z0-9_-]*)\s*(.*)$/is.exec(t)
  if (!m) return null
  return { cmd: m[1].toLowerCase(), arg: m[2].trim() }
}

/**
 * The built-in control commands, handled instantly without an LLM call (they work
 * offline / with no provider configured). A user-defined custom command can never
 * shadow these. `/reset` is an alias of `/clear`.
 */
export const BUILTIN_COMMANDS: readonly string[] = ['help', 'clear', 'reset', 'model', 'profile', 'guard']

export function isBuiltinCommand(name: string): boolean {
  return BUILTIN_COMMANDS.includes(name.toLowerCase())
}

/**
 * Resolve a user-defined custom command by name across the three scopes — the
 * narrowest present definition wins (chat → connection → overall). Returns null
 * when no scope defines it (the caller then reports "unknown command").
 */
export function resolveCustomCommand(
  name: string,
  scopes: { chat?: CustomCommand[]; channel?: CustomCommand[]; overall?: CustomCommand[] }
): CustomCommand | null {
  const n = name.toLowerCase()
  const find = (list?: CustomCommand[]): CustomCommand | undefined => list?.find((c) => c.name.toLowerCase() === n)
  return find(scopes.chat) ?? find(scopes.channel) ?? find(scopes.overall) ?? null
}

/**
 * Expand a custom command into the prompt sent as the turn: substitute every
 * `{args}` with the trailing text; if the prompt has no placeholder and the user
 * passed an argument, append it on a new line.
 */
export function expandCommand(cmd: CustomCommand, arg: string): string {
  const a = arg.trim()
  if (cmd.prompt.includes('{args}')) return cmd.prompt.split('{args}').join(a)
  return a ? `${cmd.prompt}\n\n${a}` : cmd.prompt
}

/** Words that mean "clear the override and go back to Auto". */
const CLEAR_WORDS = /^(auto|default|reset|off|clear|none)$/i

export type ModelArgResult =
  /** `/model auto` — clear the per-chat override. */
  | { kind: 'clear' }
  /** Resolved unambiguously (explicit `provider:model`, or a bare id on one provider). */
  | { kind: 'set'; model: ModelRef }
  /** A bare id exposed by several providers — the user must disambiguate. */
  | { kind: 'ambiguous'; candidates: ModelRef[] }
  /** Not a known provider/model. */
  | { kind: 'unknown'; query: string }

function dedupe(refs: ModelRef[]): ModelRef[] {
  const seen = new Set<string>()
  const out: ModelRef[] = []
  for (const r of refs) {
    const key = `${r.provider}:${r.model}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(r)
    }
  }
  return out
}

/**
 * Resolve a `/model` argument. Accepts an explicit `provider:model` (the provider
 * must be known; the model is taken as-is so a brand-new id still works), a bare
 * model id resolved against the configured providers' model lists (asking the user
 * to pick when several providers expose the same id, spec §7.1), or a clear word.
 */
export function parseModelArg(arg: string, providers: AiProviderStatus[]): ModelArgResult {
  const q = arg.trim()
  if (!q || CLEAR_WORDS.test(q)) return { kind: 'clear' }
  if (q.includes(':')) {
    const idx = q.indexOf(':')
    const provider = q.slice(0, idx).trim().toLowerCase() as AiProviderId
    const model = q.slice(idx + 1).trim()
    if (!providers.some((entry) => entry.provider === provider) || !model) return { kind: 'unknown', query: q }
    return { kind: 'set', model: { provider, model } }
  }
  const lower = q.toLowerCase()
  const candidates: ModelRef[] = []
  for (const p of providers) {
    for (const m of p.models) {
      if (m.id.toLowerCase() === lower) candidates.push({ provider: p.provider, model: m.id })
    }
  }
  const unique = dedupe(candidates)
  if (unique.length === 0) return { kind: 'unknown', query: q }
  if (unique.length === 1) return { kind: 'set', model: unique[0] }
  return { kind: 'ambiguous', candidates: unique }
}

// ── Inline approval callback protocol (Telegram, C9) ─────────────────────────
// callback_data is hard-capped at 64 bytes, so it carries only `<action>:<id>`;
// the request is looked up server-side (the store's pending map). The short
// action codes + a ~13-char requestId stay well under the limit.

/** The tappable choices on a channel approval prompt. */
export type ChannelApprovalAction =
  | 'allow' //   allow once
  | 'skip' //    skip this once
  | 'aallow' //  always allow here (remember allow)
  | 'aask' //    always ask here (remember confirm)
  | 'block' //   block here (remember deny)

const APPROVAL_ACTIONS: readonly ChannelApprovalAction[] = ['allow', 'skip', 'aallow', 'aask', 'block']

/** Parse an inline-button `callback_data` ("allow:r123") into its action + requestId. */
export function parseCallbackData(data: string): { action: ChannelApprovalAction; requestId: string } | null {
  const idx = data.indexOf(':')
  if (idx === -1) return null
  const action = data.slice(0, idx) as ChannelApprovalAction
  const requestId = data.slice(idx + 1)
  if (!requestId || !APPROVAL_ACTIONS.includes(action)) return null
  return { action, requestId }
}

/** The approval buttons for one request; "Always allow" only when remembering is allowed. */
export function approvalButtons(requestId: string, canRemember: boolean, text = uiText): { label: string; value: string }[] {
  const buttons = [
    { label: `✅ ${text('auto.c551e6cf17a5')}`, value: `allow:${requestId}` },
    { label: `✋ ${text('auto.3da474537ac3')}`, value: `skip:${requestId}` }
  ]
  if (canRemember) buttons.push({ label: `♾️ ${text('auto.611a1cce4ffe')}`, value: `aallow:${requestId}` })
  buttons.push({ label: `🔔 ${text('auto.065b047a8bc3')}`, value: `aask:${requestId}` })
  buttons.push({ label: `⛔ ${text('auto.08991ac33209')}`, value: `block:${requestId}` })
  return buttons
}

// ── /model inline-keyboard picker (Telegram, deepseek/kimi/ollama only) ─────
// Two-step picker so each keyboard stays short: a provider tap (`mdlp:`) sends
// back that provider's model buttons (`mdls:`). Distinct prefixes from the
// approval protocol above (`allow`/`skip`/…) so `parseCallbackData` safely
// returns null for these and the two protocols never collide.

/** One button per allowed provider for the first picker step. */
export function providerPickerButtons(providers: AiProviderStatus[]): { label: string; value: string }[] {
  return providers.map((provider) => ({
    label: provider.name || capitalize(provider.provider),
    value: `mdlp:${provider.provider}`
  }))
}

/** One button per model the given provider exposes, for the second picker step. */
export function modelPickerButtons(provider: AiProviderId, providers: AiProviderStatus[]): { label: string; value: string }[] {
  const status = providers.find((p) => p.provider === provider)
  return (status?.models ?? []).map((m) => ({ label: m.id, value: `mdls:${provider}:${m.id}` }))
}

export type ModelPickerTap =
  | { kind: 'provider'; provider: AiProviderId }
  | { kind: 'set'; provider: AiProviderId; model: string }

/** Parse a `mdlp:`/`mdls:` callback_data value; null for anything else (incl. approval taps). */
export function parseModelPickerCallback(data: string): ModelPickerTap | null {
  if (data.startsWith('mdlp:')) {
    const provider = data.slice('mdlp:'.length) as AiProviderId
    return provider ? { kind: 'provider', provider } : null
  }
  if (data.startsWith('mdls:')) {
    const rest = data.slice('mdls:'.length)
    const idx = rest.indexOf(':')
    if (idx === -1) return null
    const provider = rest.slice(0, idx) as AiProviderId
    const model = rest.slice(idx + 1)
    return provider && model ? { kind: 'set', provider, model } : null
  }
  return null
}

/** The `/help` text — the configurable command set surfaced to a remote chat. */
export function helpText(): string {
  return [
    'Commands:',
    '/help — this list',
    '/clear — wipe this chat (keeps saved memory)',
    '/model — show or set the model (e.g. /model claude-opus-4-8, /model openai:gpt-5.5, /model auto)',
    '/profile — show or set the personality (e.g. /profile work, /profile default)',
    '/guard — show the permission policy for this chat'
  ].join('\n')
}
