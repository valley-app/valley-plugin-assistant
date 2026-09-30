/**
 * The single, pure Guard resolver. Imported by BOTH the renderer (UX: which
 * prompt to show, "remember" overrides, dangerous mode, audit) and main
 * (authoritative enforcement in the drivers) so the decision can never diverge.
 *
 * Precedence (top → down): hard platform blocks → global guard → profile →
 * channel → chat. Combination rules:
 *   - `deny` beats everything; a lower layer can never widen it.
 *   - `confirm` beats `allow` unless the higher `confirm` is `allowPreApproval`.
 *   - a lower `allow` flips `confirm → allow` only when every higher `confirm` in
 *     the chain is pre-approvable (monotonic narrowing; lower layers never widen).
 *   - human callers (palette/hotkey) ARE the confirmation: `confirm ⇒ run`.
 *   - dangerous mode converts `confirm → allow` for autonomous callers only;
 *     it never touches `deny` or a hard block.
 */
import type {
  GuardDangerousMode,
  GuardDecision,
  GuardFileOperation,
  GuardLayers,
  GuardOverrides,
  GuardPolicy,
  GuardPolicyEntry,
  GuardRequest,
  GuardResolution
} from '@valley/plugin-sdk/guard/types'
import { isHumanCaller, isWriteFileOperation } from '@valley/plugin-sdk/guard/types'
import { hasTraversal, matchAny, matchPath } from './guardMatch'

type LayerSource = GuardResolution['source']

const ALLOW: GuardPolicyEntry = { decision: 'allow' }

function resolution(
  decision: GuardDecision,
  reason: string,
  source: LayerSource,
  canRememberApproval = false
): GuardResolution {
  return { decision, reason, source, canRememberApproval }
}

function opFor(req: GuardRequest): GuardFileOperation {
  return req.target.fileOperation ?? (req.target.sideEffect === 'write' ? 'write' : 'read')
}

function firstOverrideMatch(
  overrides: Record<string, GuardPolicyEntry> | undefined,
  relPath: string
): GuardPolicyEntry | undefined {
  if (!overrides) return undefined
  for (const [pattern, entry] of Object.entries(overrides)) {
    if (matchPath(pattern, relPath)) return entry
  }
  return undefined
}

/** The global base for a target: either a terminal deny (file scope miss) or a policy entry. */
function baseFor(req: GuardRequest, policy: GuardPolicy): { resolution: GuardResolution } | { entry: GuardPolicyEntry } {
  const { target } = req
  if (target.kind === 'tool') {
    const entry = policy.tools[target.id ?? '']
    return { entry: entry ?? (target.sideEffect === 'write' ? policy.defaultWrite : ALLOW) }
  }
  if (target.kind === 'command') {
    const entry = policy.commands[target.id ?? '']
    return { entry: entry ?? (target.sideEffect === 'write' ? policy.defaultWrite : ALLOW) }
  }
  // file
  const path = target.path ?? ''
  const op = opFor(req)
  const files = policy.files
  if (isWriteFileOperation(op)) {
    if (!matchAny(files.allowedToWrite, path)) {
      return { resolution: resolution('deny', `"${path}" is not in allowedToWrite`, 'global-guard') }
    }
    return { entry: firstOverrideMatch(files.writeOverrides, path) ?? files.defaultWrite }
  }
  if (files.visitMode === 'allow-listed-only' && !matchAny(files.allowedToVisit, path)) {
    return { resolution: resolution('deny', `"${path}" is not in allowedToVisit (allow-listed-only)`, 'global-guard') }
  }
  return { entry: firstOverrideMatch(files.readOverrides, path) ?? files.defaultRead }
}

/** A lower layer's entry for the target (tool/command override, or file pattern override). */
function layerEntryFor(layer: GuardOverrides | undefined, req: GuardRequest): GuardPolicyEntry | undefined {
  if (!layer) return undefined
  const { target } = req
  if (target.kind === 'tool') return layer.tools?.[target.id ?? '']
  if (target.kind === 'command') return layer.commands?.[target.id ?? '']
  const overrides = isWriteFileOperation(opFor(req)) ? layer.fileWriteOverrides : layer.fileReadOverrides
  return firstOverrideMatch(overrides, target.path ?? '')
}

interface Combined {
  decision: GuardDecision
  /** Whether a lower `allow` could still flip the current `confirm` to `allow`. */
  preApprovable: boolean
  source: LayerSource
  reason: string
}

/** Fold layers top→down per the combination rules. */
function combine(entries: { entry?: GuardPolicyEntry; source: LayerSource }[]): Combined {
  let decision: GuardDecision = 'allow'
  let preApprovable = true
  let source: LayerSource = 'global-guard'
  let reason = 'Allowed (no stricter layer)'
  for (const { entry, source: layer } of entries) {
    if (!entry) continue
    if (entry.decision === 'deny') {
      decision = 'deny'
      preApprovable = false
      source = layer
      reason = `Blocked at ${layer}`
    } else if (decision === 'deny') {
      continue // a lower layer can never widen a deny
    } else if (entry.decision === 'confirm') {
      if (decision === 'allow') {
        source = layer
        reason = `Requires confirmation (${layer})`
      }
      decision = 'confirm'
      preApprovable = preApprovable && Boolean(entry.allowPreApproval)
    } else {
      // entry.decision === 'allow'
      if (decision === 'confirm' && preApprovable) {
        decision = 'allow'
        source = layer
        reason = `Pre-approved at ${layer}`
      }
    }
  }
  return { decision, preApprovable, source, reason }
}

function dangerousActive(d: GuardDangerousMode): boolean {
  return d.enabled && d.scope !== 'off'
}

export function resolveGuard(
  req: GuardRequest,
  policy: GuardPolicy,
  layers: GuardLayers,
  dangerous: GuardDangerousMode,
  _now: number
): GuardResolution {
  const { target, caller } = req

  // 1. Hard platform blocks (files) — unbypassable, even by dangerous mode.
  if (target.kind === 'file' && target.path != null) {
    if (hasTraversal(target.path)) {
      return resolution('deny', `Path traversal rejected: ${target.path}`, 'hard-block')
    }
    const blocked = [
      ...policy.files.blocked,
      ...(layers.profile?.blocked ?? []),
      ...(layers.channel?.blocked ?? []),
      ...(layers.chat?.blocked ?? [])
    ]
    if (matchAny(blocked, target.path)) {
      return resolution('deny', `Blocked path: ${target.path}`, 'hard-block')
    }
  }

  // 2. Global base — a file-scope miss is a terminal deny.
  const base = baseFor(req, policy)
  if ('resolution' in base) return base.resolution

  // 3. Combine global + lower layers.
  const layered = [
    { entry: base.entry, source: 'global-guard' as LayerSource },
    { entry: layerEntryFor(layers.profile, req), source: 'profile' as LayerSource },
    { entry: layerEntryFor(layers.channel, req), source: 'channel' as LayerSource },
    { entry: layerEntryFor(layers.chat, req), source: 'chat' as LayerSource }
  ]
  const aboveChat = combine(layered.slice(0, 3))
  const full = combine(layered)

  // 4. Human callers: the click IS the confirmation. `deny`/hard-block still stop them.
  if (isHumanCaller(caller)) {
    if (full.decision === 'deny') return resolution('deny', full.reason, full.source)
    if (full.decision === 'confirm') return resolution('allow', 'Human-initiated action runs without a prompt', 'caller')
    return resolution('allow', full.reason, full.source)
  }

  // 5. Autonomous callers.
  if (full.decision === 'deny') return resolution('deny', full.reason, full.source)
  if (full.decision === 'allow') return resolution('allow', full.reason, full.source)

  // confirm — dangerous mode may convert it; never deny/blocked.
  if (dangerousActive(dangerous)) {
    return resolution('allow', 'Full access: confirm → allow', 'dangerous-mode')
  }
  const canRemember = aboveChat.decision !== 'deny' && aboveChat.preApprovable
  return resolution('confirm', full.reason, full.source, canRemember)
}
