import { supportedEfforts } from '../models'
import { allowedWhilePlanning } from '../backend/tools/catalog/general/planning'
import { runNativeHarness } from './nativeHarness'
import type { ProjectActivity } from '@valley/plugin-sdk/pluginExecution'
import type { ValleyPluginApi } from '../api'
import type { AiAttachment, AiChatRequest, AiMessage, AiProviderId, AiToolCall, AssistantConfig } from '../types'
import type { GuardAuditEntry, GuardCaller, GuardFileOperation, GuardLayers, GuardPolicy, GuardTarget } from '@valley/plugin-sdk/guard/types'
import { redactSecrets, resolveGuard, type ApprovalDraft } from '@valley/plugin-sdk'
import { valleyCancellationOf, type ValleyCancellation } from '@valley/plugin-sdk/valleyCancellation'
import { resolveRouting, route, type RouteResult, type RoutingLayers } from '../router'
import {
  toToolDefs,
  failureHint,
  looksLikeFailure,
  clip,
  type AgentTool,
  type InAppSurface,
  type ToolRunResult
} from './tools'
import { recoverToolCalls } from './toolCallRecovery'
import { coerceArgs } from './coerceArgs'
import { createStreamBudget } from '../streamLimits'

/**
 * The tools-in-a-loop orchestrator (Cursor's "agent = tools in a loop"): route a
 * model, stream a turn, execute any tool calls (gated by the shared Guard
 * resolver), append the results, and repeat until the model stops calling tools,
 * the step cap is hit, or the run is cancelled. Pure of React — driven entirely
 * by the injected `api` + callbacks, so it is unit-testable against the mock SDK.
 *
 * Gating (C6): direct-effect tools resolve by `kind:'tool'`/`'file'` and prompt
 * here; bus-dispatching tools resolve by their
 * underlying command id and, on approval, dispatch with a one-time token so the
 * bus enforces `deny` without prompting a second time. Dynamic provider tools
 * can fan out to several commands and delegate gating entirely to the bus.
 */
const MAX_STEPS = 12
/** Consecutive all-failed steps before the loop gives up instead of spinning to the cap. */
const MAX_FAILED_STREAK = 3
/** Per-tool-call run cap. Providers may request a larger declared budget. */
const TOOL_TIMEOUT_MS = 60_000
const MAX_TOOL_TIMEOUT_MS = 300_000
/** Absolute cap on any single tool result entering model context (tools clip
 *  themselves at 6–8k; this is the belt for un-clipped paths). */
const TOOL_RESULT_HARD_CAP = 16_000
/** Per-step provider payload budget (chars over content + attachments). Generous —
 *  short runs are untouched; only very long tool loops get their oldest steps elided. */
const CONTEXT_CHAR_BUDGET = 150_000

function toolTimeoutMs(tool: AgentTool): number {
  return Math.min(MAX_TOOL_TIMEOUT_MS, Math.max(1, tool.timeoutMs ?? TOOL_TIMEOUT_MS))
}

/**
 * Bound the per-step provider payload: when the working context exceeds the char
 * budget, drop whole oldest messages — but never the FIRST user message (the
 * original task), never the segment from the last user message on, and never
 * leaving an orphaned tool result at the head of the kept tail (a provider
 * rejects a tool message with no preceding tool call). Returns the input array
 * untouched (same reference) when within budget. `trimmed` is the count of
 * dropped messages; the caller folds it into the system prompt so the message
 * list never carries a second `system` entry.
 */
export function boundContext(
  messages: AiMessage[],
  budget = CONTEXT_CHAR_BUDGET
): { messages: AiMessage[]; trimmed: number } {
  const size = (m: AiMessage): number =>
    (m.content?.length ?? 0) + (m.attachments?.reduce((s, a) => s + a.dataBase64.length, 0) ?? 0) + 40
  let total = messages.reduce((s, m) => s + size(m), 0)
  if (total <= budget) return { messages, trimmed: 0 }
  const firstUser = messages.findIndex((m) => m.role === 'user')
  const lastUser = messages.map((m) => m.role).lastIndexOf('user')
  let cut = 0
  while (cut < lastUser && total > budget) {
    if (cut !== firstUser) total -= size(messages[cut])
    cut++
  }
  while (cut < lastUser && messages[cut].role === 'tool') cut++
  if (cut === 0) return { messages, trimmed: 0 }
  const head = firstUser >= 0 && firstUser < cut ? [messages[firstUser]] : []
  return { messages: [...head, ...messages.slice(cut)], trimmed: cut - head.length }
}

/** Stable signature for a tool call so identical repeats can be detected regardless of key order. */
function callSignature(name: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort()
  return `${name}:${keys.map((k) => `${k}=${JSON.stringify(args[k])}`).join('&')}`
}

/** Direct-effect file tools → the file operation the resolver should gate them as. */
const FILE_WRITE_TOOLS: Record<string, GuardFileOperation> = {
  write_file: 'write',
  delete_file: 'delete',
  write_note: 'write',
  delete_note: 'delete'
}

export interface StreamResult {
  text: string
  toolCalls: AiToolCall[]
  error?: string
}

/** No stream event for this long ⇒ the run is stalled: cancel + surface an error
 *  instead of hanging the turn forever (a provider that never emits `done`, a
 *  dropped driver event). Generous — long silent "thinking" phases are normal. */
const STREAM_STALL_MS = 180_000

/**
 * Run a single streamed model turn; resolves when the provider emits `done`.
 * Self-heals the two hang modes: an inactivity timeout cancels a stalled run,
 * and an `error` event resolves shortly even if the terminal `done` got lost.
 */
export function streamOnce(
  api: ValleyPluginApi,
  req: AiChatRequest,
  onText: (partial: string) => void
): Promise<StreamResult> {
  return new Promise<StreamResult>((resolve) => {
    let text = ''
    const toolCalls: AiToolCall[] = []
    const budget = createStreamBudget()
    let error: string | undefined
    let settled = false
    let stallTimer: ReturnType<typeof setTimeout> | undefined
    let errorFallback: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(stallTimer)
      clearTimeout(errorFallback)
      off()
      resolve({ text, toolCalls, error })
    }
    const armStallTimer = (): void => {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        error = error ?? `No response from ${req.provider} for ${Math.round(STREAM_STALL_MS / 1000)}s — the stream stalled. Retry, or switch models.`
        void api.assistant.cancel(req.requestId).catch(() => undefined)
        finish()
      }, STREAM_STALL_MS)
    }
    armStallTimer()
    const off = api.assistant.onStream((event) => {
      if (settled || event.requestId !== req.requestId) return
      try { budget(event) } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure)
        void api.assistant.cancel(req.requestId).catch(() => undefined)
        finish()
        return
      }
      armStallTimer()
      if (event.type === 'text') {
        text += event.text
        onText(text)
      } else if (event.type === 'tool_call') {
        toolCalls.push(event.call)
      } else if (event.type === 'error') {
        error = event.error
        // The engine always follows an error with `done`; resolve soon regardless
        // so a lost terminal event can't wedge the turn.
        clearTimeout(errorFallback)
        errorFallback = setTimeout(finish, 1500)
      } else if (event.type === 'done') {
        finish()
      }
    })
    void api.assistant.chat(req).then((res) => {
      if (!res.ok) {
        error = res.error ?? 'Failed to start run'
        finish()
      }
    }, failure => { error = failure instanceof Error ? failure.message : String(failure); finish() })
  })
}

/** The Guard target a direct-effect tool resolves as (file tools by path/op, else by name). */
export function targetForTool(tool: AgentTool, args: Record<string, unknown>): GuardTarget {
  const fileOp = FILE_WRITE_TOOLS[tool.name]
  if (fileOp) {
    return { kind: 'file', path: typeof args.path === 'string' ? args.path : '', fileOperation: fileOp, sideEffect: 'write' }
  }
  return {
    kind: 'tool',
    id: tool.providerOwner ? `${tool.providerOwner}:${tool.name}` : tool.name,
    sideEffect: tool.sideEffect
  }
}

async function safeRun(tool: AgentTool, args: Record<string, unknown>, opts?: import('./tools').RunOpts): Promise<string | ToolRunResult> {
  const controller = new AbortController()
  const cancellation = valleyCancellationOf(controller)
  const cancel = () => controller.abort()
  opts?.cancellation?.addEventListener('abort', cancel, { once: true })
  if (opts?.cancellation?.aborted) cancel()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    cancellation.throwIfAborted()
    const running = tool.run(args, { ...opts, cancellation })
    const ms = toolTimeoutMs(tool)
    const timeout = new Promise<string>(resolve => {
      timer = setTimeout(() => {
        controller.abort()
        const message = `Error: ${tool.name} timed out after ${Math.round(ms / 1000)}s.`
        if (tool.drainOnCancel) void running.then(() => resolve(message), () => resolve(message))
        else resolve(message)
      }, ms)
    })
    return await Promise.race([running, timeout])
  } catch (err) {
    return `Error running ${tool.name}: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    clearTimeout(timer)
    opts?.cancellation?.removeEventListener('abort', cancel)
  }
}

export function friendlyStreamError(error: string): string {
  error = redactSecrets(error).replace(/^(?:Error invoking remote method ['"][^'"]+['"]:\s*)?(?:Error:\s*)*/, '').trim()
  const jsonStart = error.indexOf('{')
  if (jsonStart >= 0) {
    try {
      const detail = JSON.parse(error.slice(jsonStart))
      const message = detail?.error?.message ?? detail?.message
      if (typeof message === 'string' && message.trim()) error = error.slice(0, jsonStart) + message
    } catch { /* Keep non-JSON diagnostics readable. */ }
  }
  const lower = error.toLowerCase()
  if (lower.includes('insufficient balance') || /\b402\b/.test(error)) {
    return 'Provider error: insufficient balance. Switch to another configured model/provider or add credits for the selected provider.'
  }
  if (lower.includes('no api key') || lower.includes('no credential') || lower.includes('sign in, set the provider environment variable')) {
    return 'Provider error: no credential. Sign in, set the provider environment variable, or add an API key in Settings → AI Providers.'
  }
  return error
}

export interface RunAgentOptions {
  planning?: boolean
  harness?: import('../types').HarnessId
  api: ValleyPluginApi
  config: AssistantConfig
  systemPrompt: string
  /** Conversation so far, including the new user message (system is added here). */
  messages: AiMessage[]
  tools: AgentTool[]
  reasoningEffort?: import('../types').ReasoningEffort
  modelOverride?: { provider: AiProviderId; model: string; connectionId?: string } | null
  /** Where the turn originated — forwarded to usage metering. */
  origin?: 'ui' | 'channel'
  /** The remote chat this turn replies into (for tools that push to the channel, e.g. quizzes). */
  channel?: { channelId: string; chatRef: string } | null
  /** The in-app chat surface tools push render-only content to (inline images, quiz buttons). */
  inApp?: InAppSurface
  /** Stable Notes conversation id for stateful providers. */
  conversationId?: string
  /** Whether the chosen model supports the provider's native web tool. */
  modelSupportsWeb?: (provider: AiProviderId, model: string) => boolean
  /** Live partial of the assistant message currently streaming. */
  onText: (partial: string) => void
  /** A completed message (assistant or tool result) was appended. */
  onMessage: (message: AiMessage) => void
  shouldYield?: () => boolean
  onRunStart?: (runId: string) => void
  onActivity?: (event: ProjectActivity, output?: string) => Promise<void>
  /** The router's pick for the current step (for the Auto badge). */
  onModel?: (routed: RouteResult) => void
  /** The run id of the active turn (so the caller can cancel it). */
  onRequestStart?: (requestId: string) => void
  /**
   * Raise an approval prompt for a `confirm` decision (in-app card or channel
   * buttons). Resolve false to skip the action. The store builds the full
   * `PermissionRequest` from this draft.
   */
  requestApproval: (draft: ApprovalDraft) => Promise<boolean>
  /** Mint a one-time token so an approved bus dispatch isn't re-prompted by the bus (C6). */
  mintApprovalToken?: () => string
  /** Append a guard decision to the audit trail (allow / deny / bypass / expired / skipped). */
  audit?: (entry: GuardAuditEntry) => void
  /** Lower-layer guard narrowing (profile/channel/chat) — empty until later phases. */
  guardLayers?: GuardLayers
  /** Aborted when the run is cancelled — threaded into tool runs and bus dispatches. */
  cancellation?: ValleyCancellation
  /** Routing precedence layers for chat, channel, and profile scopes. */
  routingLayers?: RoutingLayers
  isCancelled: () => boolean
  maxSteps?: number
}

export async function runAgent(opts: RunAgentOptions): Promise<void> {
  const { api, config, systemPrompt, onText, onMessage, isCancelled } = opts
  const tools = opts.planning ? opts.tools.filter(allowedWhilePlanning) : opts.tools
  // Render-only messages (e.g. injected quiz images) are shown in the chat but must
  // never reach the provider — strip them from the working context.
  const work = opts.messages.filter((m) => m.render == null && !m.error)
  const maxSteps = opts.maxSteps ?? MAX_STEPS
  const runId = crypto.randomUUID()
  const activity = async (call: AiToolCall, state: ProjectActivity['state'], output?: string): Promise<void> => {
    await opts.onActivity?.({ runId, callId: call.id, name: call.name, state, timestamp: Date.now(), arguments: call.arguments }, output)
  }

  // The shared rule set for this run. The caller maps the origin onto a guard
  // caller; the policy + dangerous mode come from the (live) config; lower layers
  // narrow it. Resolution is identical to what main enforces.
  const caller: GuardCaller = opts.origin === 'channel' ? 'channel' : 'agent'
  const policy: GuardPolicy = config.guard
  const layers = opts.guardLayers ?? {}
  const dangerous = config.guard.dangerousMode
  const audit = opts.audit ?? ((): void => {})

  const recordDecision = (target: GuardTarget, source: GuardAuditEntry['source'], reason: string, decision: GuardAuditEntry['decision']): void =>
    audit({
      ts: Date.now(),
      caller,
      decision,
      source,
      reason,
      targetKind: target.kind,
      targetId: target.id,
      path: target.path,
      fileOperation: target.fileOperation,
      channelId: opts.channel?.channelId,
      chatId: opts.conversationId
    })

  const draftFor = (target: GuardTarget, tool: AgentTool, args: Record<string, unknown>, canRemember: boolean): ApprovalDraft => ({
    caller,
    target,
    actionLabel: tool.name,
    argsPreview: args,
    canRememberApproval: canRemember,
    channelId: opts.channel?.channelId
  })

  const approve = async (draft: ApprovalDraft, cancellation?: ValleyCancellation): Promise<boolean> => {
    if (cancellation?.aborted) return false
    let cancel!: () => void
    const interrupted = new Promise<boolean>(resolve => { cancel = () => resolve(false) })
    cancellation?.addEventListener('abort', cancel, { once: true })
    try { return await Promise.race([opts.requestApproval(draft), interrupted]) }
    finally { cancellation?.removeEventListener('abort', cancel) }
  }

  /** Resolve, prompt (once) if needed, and run one tool call. */
  const gateAndRun = async (tool: AgentTool, args: Record<string, unknown>, call: AiToolCall, cancellation = opts.cancellation): Promise<string | ToolRunResult> => {
    if (opts.planning && !allowedWhilePlanning(tool)) return 'Blocked: planning mode requires explicit approval of the proposed plan before execution.'
    // Bus-dispatching tools: gate by the underlying command id (prompt once here,
    // token-dedup the bus). When the tool fans out to several commands,
    // let the bus gate each one — its underlying commands are reads.
    const conversationId = opts.conversationId
    const channel = opts.channel
    const inApp = opts.inApp
    const execution = { runId, callId: call.id }
    if (tool.dispatch === 'bus') {
      const cmdId = tool.busCommandId?.(args) ?? null
      if (!cmdId) return safeRun(tool, args, { conversationId, channel, inApp, cancellation, activity: execution })
      if (api.commands.list().some((command) => command.id === cmdId && command.agentVisibility === 'forbidden')) {
        return `"${cmdId}" isn't available to the assistant — ask the user to do this from the app UI.`
      }
      const target: GuardTarget = { kind: 'command', id: cmdId, sideEffect: tool.sideEffect }
      const res = resolveGuard({ caller, target }, policy, layers, dangerous, Date.now())
      if (res.decision === 'deny') {
        recordDecision(target, res.source, res.reason, 'deny')
        return `Blocked by policy: ${res.reason}`
      }
      let token: string | undefined
      if (res.decision === 'confirm') {
        await activity(call, 'approval')
        const ok = await approve(draftFor(target, tool, args, res.canRememberApproval), cancellation)
        // A false resolved by cancelling the run audits as `skipped` — the user
        // stopped the turn, they did not deny this specific action.
        recordDecision(target, res.source, res.reason, ok ? 'allow' : isCancelled() ? 'skipped' : 'deny')
        if (!ok) return 'The user declined this action.'
        token = opts.mintApprovalToken?.()
      } else if (res.source === 'dangerous-mode') {
        recordDecision(target, res.source, res.reason, 'bypass')
      }
      return safeRun(tool, args, { approvalToken: token, conversationId, channel, inApp, cancellation, activity: execution })
    }
    // Direct-effect tools: gate by tool/file kind, prompt here, run directly.
    const target = targetForTool(tool, args)
    const res = resolveGuard({ caller, target }, policy, layers, dangerous, Date.now())
    if (res.decision === 'deny') {
      recordDecision(target, res.source, res.reason, 'deny')
      return `Blocked by policy: ${res.reason}`
    }
    if (res.decision === 'confirm') {
      await activity(call, 'approval')
      const ok = await approve(draftFor(target, tool, args, res.canRememberApproval), cancellation)
      recordDecision(target, res.source, res.reason, ok ? 'allow' : isCancelled() ? 'skipped' : 'deny')
      return ok ? safeRun(tool, args, { conversationId, channel, inApp, cancellation, activity: execution }) : 'The user declined this action.'
    }
    if (res.source === 'dangerous-mode') recordDecision(target, res.source, res.reason, 'bypass')
    return safeRun(tool, args, { conversationId, channel, inApp, cancellation, activity: execution })
  }

  // Signatures of calls that already failed this run — a weak model that repeats
  // the exact same broken call gets told to change approach instead of spinning.
  const failedSignatures = new Set<string>()
  let failedStreak = 0

  for (let step = 0; step < maxSteps; step++) {
    if (isCancelled() || opts.shouldYield?.()) return
    const lastUser = [...work].reverse().find((m) => m.role === 'user')?.content ?? ''
    const configured = config.providers.filter((p) => p.configured).map((p) => p.provider)
    const modelFor = (provider: AiProviderId): string | undefined =>
      config.providers.find((p) => p.provider === provider)?.models[0]?.id
    const routed = route(
      { text: lastUser, toolDepth: step, override: opts.modelOverride, configured, modelFor, connections: opts.conversationId ? config.connections : undefined },
      resolveRouting(config.routing, opts.routingLayers)
    )
    if (opts.reasoningEffort && !supportedEfforts(routed).includes(opts.reasoningEffort)) throw new Error('Reasoning effort is not supported by this model')
    opts.onModel?.(routed)

    const requestId = (globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${step}`) as string
    opts.onRequestStart?.(requestId)
    const webOn = opts.modelSupportsWeb?.(routed.provider, routed.model) ?? false
    // No native web tool for this model: say so up front, so the model states the
    // limitation (or reaches for the browser tools) instead of inventing facts.
    const sys = webOn
      ? systemPrompt
      : `${systemPrompt}\n\nNo provider web-search is available for this model on this turn. If asked about live or current information, say you cannot search the web natively — use an available provider tool whose description supports browsing, or explain that none is available, instead of guessing.`
    const bounded = boundContext(work)
    const sysWithTrim = bounded.trimmed
      ? `${sys}\n\n[Note: ${bounded.trimmed} earlier message${bounded.trimmed === 1 ? '' : 's'} of this conversation were trimmed to fit the context budget. The original user request is preserved.]`
      : sys
    const req: AiChatRequest = {
      requestId,
      provider: routed.provider,
      connectionId: routed.connectionId,
      model: routed.model,
      messages: [{ role: 'system', content: sysWithTrim }, ...bounded.messages],
      tools: toToolDefs(tools),
      web: webOn,
      ...(routed.provider === 'deepseek' ? {} : { maxTokens: 8192 }),
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      origin: opts.origin ?? 'ui',
      conversationId: opts.conversationId
    }

    if (opts.harness && opts.harness !== 'valley') {
      opts.onRunStart?.(runId)
      await runNativeHarness(opts, req, runId, async (call, cancellation) => {
        await activity(call, 'running')
        const tool = tools.find(tool => tool.name === call.name)
        const result = tool ? await gateAndRun(tool, coerceArgs(tool.parameters, call.arguments), call, cancellation) : `Error: Unknown tool ${call.name}`
        const text = typeof result === 'string' ? result : result.text
        await activity(call, isCancelled() || opts.harness !== 'valley' && cancellation?.aborted ? 'cancelled' : looksLikeFailure(text) ? 'failed' : 'completed', typeof result === 'string' ? result : result.output ?? result.text)
        return clip(redactSecrets(text), TOOL_RESULT_HARD_CAP)
      })
      return
    }

    const { text, toolCalls, error } = await streamOnce(api, req, onText)
    if (error) {
      const friendly = friendlyStreamError(error)
      if (text) onMessage({ role: 'assistant', content: text })
      onMessage({ role: 'assistant', content: friendly, error: true })
      return
      return
    }

    // Recover tool calls a weak/local model emitted as text (JSON blob, fenced
    // block, or <tool_call> tag) instead of through the provider's structured
    // channel — so it still acts, and the user sees prose (cleanedText) rather
    // than raw JSON. Native structured calls always take precedence.
    let effectiveCalls = toolCalls
    let assistantText = text
    if (!toolCalls.length && text) {
      const recovered = recoverToolCalls(text, tools.map((t) => t.name))
      if (recovered.calls.length) {
        effectiveCalls = recovered.calls
        assistantText = recovered.cleanedText
      }
    }

    const assistant: AiMessage = { activityRunId: runId, role: 'assistant', content: assistantText, toolCalls: effectiveCalls.length ? effectiveCalls : undefined, ts: Date.now() }
    work.push(assistant)
    onMessage(assistant)
    if (!effectiveCalls.length) return
    if (isCancelled()) {
      for (const call of effectiveCalls) await activity(call, 'cancelled')
      return
    }

    let anySucceeded = false
    for (const call of effectiveCalls) {
      // A cancel mid-step stops before the *next* tool call — the current one
      // finishes (or times out) so its result is never half-recorded.
      if (isCancelled() || opts.shouldYield?.()) {
        for (const pending of effectiveCalls.slice(effectiveCalls.indexOf(call))) {
          await activity(pending, 'cancelled')
          if (opts.shouldYield?.()) onMessage({ role: 'tool', toolCallId: pending.id, name: pending.name, content: 'Skipped because the conversation was redirected.', activityRunId: runId })
        }
        return
      }
      await activity(call, 'running')
      const tool = tools.find((t) => t.name === call.name)
      // Reshape model-supplied args against the tool's schema (stringified arrays,
      // "true"/"3", placeholder strings, double-wrapped objects) before running.
      const args = tool ? coerceArgs(tool.parameters, call.arguments) : call.arguments
      const signature = callSignature(call.name, args)
      let resultText: string
      let attachment: AiAttachment | undefined
      let fullOutput: string | undefined
      if (!tool) {
        resultText = `Error: unknown tool "${call.name}". Available tools: ${tools.map((t) => t.name).join(', ')}.`
      } else if (failedSignatures.has(signature)) {
        resultText = `You already tried this exact ${call.name} call and it failed. Change the arguments or stop and tell the user what you need.`
      } else {
        const ran = await gateAndRun(tool, args, call)
        fullOutput = typeof ran === 'string' ? ran : ran.output ?? ran.text
        // Belt for every tool result entering context: hard cap + credential mask
        // (tools clip themselves, but no path may skip this).
        resultText = clip(redactSecrets(typeof ran === 'string' ? ran : ran.text), TOOL_RESULT_HARD_CAP)
        attachment = typeof ran === 'string' ? undefined : ran.attachment
        if (looksLikeFailure(resultText)) {
          failedSignatures.add(signature)
          const hint = failureHint(api, call.name, args, resultText)
          if (hint) resultText = `${resultText}\n${hint}`
        } else {
          anySucceeded = true
        }
      }
      await activity(call, isCancelled() ? 'cancelled' : looksLikeFailure(resultText) ? 'failed' : 'completed', fullOutput ?? resultText)
      const toolMsg: AiMessage = { activityRunId: runId, role: 'tool', toolCallId: call.id, name: call.name, content: resultText }
      work.push(toolMsg)
      onMessage(toolMsg)
      // Vision: a provider tool may also return an image. Surface it
      // to the model as a provider-visible user message — reusing the existing
      // attachments→image-block mapping — right after its text tool result. The tool
      // message stays text, so non-vision providers and the text-only path are intact.
      if (attachment) {
        const shot: AiMessage = { role: 'user', content: `[image from ${call.name}]`, attachments: [attachment] }
        work.push(shot)
        onMessage(shot)
      }
    }
    if (isCancelled()) return
    // Break the spin the screenshots show: after several all-failed steps, stop
    // and ask for help instead of looping to the step cap.
    if (anySucceeded) {
      failedStreak = 0
    } else if (++failedStreak >= MAX_FAILED_STREAK) {
      onMessage({ role: 'assistant', content: "I couldn't complete that after several attempts. Could you rephrase the request or give me a bit more detail?" })
      return
    }
  }
  onMessage({ role: 'assistant', content: `(Reached the ${maxSteps}-step limit — stopping. Ask me to continue if you want me to keep going.)` })
}
