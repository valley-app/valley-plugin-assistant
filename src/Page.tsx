import { ErrorNotice } from './Preferences'
import { VoiceControls } from './voice/VoiceControls'
import { MessageAttachments } from './media/MessageAttachments'
import { route } from './router'
import { SlashMenu, type SlashCommand } from './composer/SlashMenu'
import { modelValue, parseModelValue, supportedEfforts } from './models'
import { useToolActivity, ToolActivityRow, toolPresentation, ActivityLabel, WorkDuration, type ActivityStep } from './ToolActivity'
import { formatIsoDateByPattern } from '@valley/plugin-sdk/datePattern'
import { React, api } from './runtime'
import type { FC, ReactNode } from 'react'
import type { MainWorkspaceViewProps } from '@valley/plugin-sdk'
import type { AiMessage, AiProviderId, AiToolCall, ReasoningEffort } from './types'
import type { PermissionRequest } from '@valley/plugin-sdk/guard/types'
import { assetUrlForRelPath } from '@valley/plugin-sdk/fileTypes'
import { usePluginSetting, useAssistant, useChannels } from './hooks'
import {
  Chat, Model, Lightning, Reset, Steer, Queue, ReadBook, ArrowDown,
  Pencil,
  Plus,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Folder,
  Hand,
  Send,
  Stop,
  Telegram,
  Tool,
  Warning,
  WhatsApp,
  X
} from './icons'
import type { InboundAttachment } from './types'
import { uiText } from './localization'
import { LuSettings } from './settingsIcons'

/** Unsupported formats remain downloadable file attachments. */
function attachmentKind(file: File): InboundAttachment['kind'] | null {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf'
  if (file.type.startsWith('audio/')) return 'audio'
  return 'file'
}

/** Where a picked/dropped attachment is written when Chat settings name no folder. */
export const DEFAULT_ATTACH_INBOX = '.valley/plugins/data/assistant/attachment'

/** Read a File's bytes as a base64 string (no data-URL prefix). */
function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

type ApprovalAction = 'allow-once' | 'skip' | 'always-allow' | 'always-ask' | 'block'

/** The Guard approval card — one prompt, the full button set (C4.4). */
const ApprovalCard: FC<{ request: PermissionRequest; onRespond: (a: ApprovalAction) => void }> = ({ request, onRespond }) => {
  const targetLabel = request.target.path ?? request.target.id ?? request.actionLabel
  let args = ''
  try {
    args = JSON.stringify(request.argsPreview, null, 2)
  } catch {
    args = String(request.argsPreview)
  }
  return (
    <div className="assistant-approval">
      <div className="assistant-approval-text">
        {uiText('auto.3ad0e3698278')}{' '}<code>{request.actionLabel}</code>
        {targetLabel !== request.actionLabel && <span className="assistant-approval-target"> · {targetLabel}</span>}?
      </div>
      <div className="assistant-approval-actions">
        <button className="assistant-btn" onClick={() => onRespond('allow-once')}>
          <Check className="" /> {uiText('auto.c551e6cf17a5')}</button>
        <button className="assistant-btn assistant-btn-ghost" onClick={() => onRespond('skip')}>
          <X className="" /> {uiText('auto.3da474537ac3')}</button>
        {request.canRememberApproval && (
          <button className="assistant-btn assistant-btn-ghost" onClick={() => onRespond('always-allow')}>
            {uiText('auto.611a1cce4ffe')}</button>
        )}
        <button className="assistant-btn assistant-btn-ghost" onClick={() => onRespond('always-ask')}>
          {uiText('auto.065b047a8bc3')}</button>
        <button className="assistant-btn assistant-btn-ghost assistant-btn-danger" onClick={() => onRespond('block')}>
          {uiText('auto.08991ac33209')}</button>
      </div>
      {(args && args !== '{}' && args !== 'undefined') && (
        <details className="assistant-approval-details">
          <summary>{uiText('auto.dc3decbb9384')}</summary>
          <pre className="assistant-approval-args">{args}</pre>
          {request.diffPreview && <pre className="assistant-approval-args">{request.diffPreview}</pre>}
        </details>
      )}
    </div>
  )
}

interface ActivityEntry {
  step?: ActivityStep
  message?: AiMessage
  runId?: string
  call?: AiToolCall
  result?: AiMessage
}

type RenderItem =
  | { kind: 'message'; message: AiMessage }
  | { kind: 'activity'; entries: ActivityEntry[]; startedAt?: number; endedAt?: number }

export function buildRenderItems(messages: AiMessage[], steps: ActivityStep[] = []): RenderItem[] {
  const items: RenderItem[] = []
  let i = 0
  while (i < messages.length) {
    const message = messages[i]
    if (message.role === 'system') {
      i += 1
      continue
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      if (message.content.trim()) {
        items.push({ kind: 'message', message })
      }

      const callIds = new Set(message.toolCalls.map((call) => call.id))
      const results: AiMessage[] = []
      let j = i + 1
      while (j < messages.length && messages[j].role === 'tool') {
        const toolCallId = messages[j].toolCallId
        if (toolCallId && !callIds.has(toolCallId)) break
        results.push(messages[j])
        j += 1
      }

      const usedResults = new Set<AiMessage>()
      const entries: ActivityEntry[] = message.toolCalls.map((call) => {
        const result =
          results.find((r) => r.toolCallId === call.id && !usedResults.has(r)) ??
          results.find((r) => r.name === call.name && !usedResults.has(r))
        if (result) usedResults.add(result)
        return { call, result, runId: message.activityRunId }
      })
      results.filter((result) => !usedResults.has(result)).forEach((result) => entries.push({ result }))
      items.push({ kind: 'activity', entries })
      i = j
      continue
    }

    if (message.role === 'tool') {
      items.push({ kind: 'activity', entries: [{ result: message }] })
      i += 1
      continue
    }

    items.push({ kind: 'message', message })
    i += 1
  }
  const grouped: RenderItem[] = []
  let turn: RenderItem[] = []
  const used = new Set<ActivityStep>()
  const flush = (nextTime = Infinity): void => {
    if (!turn.length) return
    const entries: ActivityEntry[] = []
    const final = [...turn].reverse().find(item => item.kind === 'message' && item.message.role === 'assistant' && !item.message.toolCalls?.length)
    // The opening line (text written before the first tool call) stays above the work block; later text between tools stays inside it.
    const first = turn.find(item => item.kind !== 'message' || item.message.role !== 'user')
    const opening = first?.kind === 'message' && first.message.role === 'assistant' && first.message.toolCalls?.length && first !== final ? first : undefined
    const runIds = new Set(turn.flatMap(item => item.kind === 'message' ? [item.message.activityRunId] : item.entries.map(entry => entry.runId ?? entry.result?.activityRunId)).filter(Boolean))
    const firstTime = turn.find(item => item.kind === 'message' && item.message.role === 'user')
    const start = firstTime?.kind === 'message' ? firstTime.message.ts ?? 0 : 0
    for (const item of turn) {
      if (item.kind === 'message' && item.message.role === 'user') grouped.push(item)
      else if (item.kind === 'message' && item !== final && item !== opening) entries.push({ message: item.message })
      else if (item.kind === 'activity') for (const entry of item.entries) {
        const step = steps.find(step => step.callId === (entry.call?.id ?? entry.result?.toolCallId) && (!(entry.runId ?? entry.result?.activityRunId) || step.runId === (entry.runId ?? entry.result?.activityRunId)))
        if (step) used.add(step)
        entries.push({ ...entry, step })
      }
    }
    for (const step of steps) {
      if (used.has(step) || steps.some(parent => parent.runId === step.runId && parent.callId === step.parentCallId) || (step.name === 'deepseek' && step.state !== 'failed')) continue
      if (runIds.has(step.runId) || (step.startedAt >= start && step.startedAt < nextTime)) {
        used.add(step); entries.push({ step })
      }
    }
    const turnSteps = steps.filter(step => runIds.has(step.runId) || (!runIds.size && step.startedAt >= start && step.startedAt < nextTime))
    const roots = turnSteps.filter(step => step.name === 'deepseek' && !step.parentCallId)
    const timestamps = turn.flatMap(item => item.kind === 'message' ? [item.message.ts] : item.entries.map(entry => entry.result?.ts)).filter((time): time is number => time != null && Number.isFinite(time))
    const starts = roots.length ? roots.map(step => step.startedAt) : [...timestamps, ...turnSteps.map(step => step.startedAt)]
    const ends = roots.length ? roots.filter(step => step.state !== 'running' && step.state !== 'approval').map(step => step.timestamp) : [...timestamps, ...turnSteps.map(step => step.timestamp)]
    if (opening) grouped.push(opening)
    if (entries.length) grouped.push({ kind: 'activity', entries, startedAt: starts.length ? Math.min(...starts) : undefined, endedAt: ends.length ? Math.max(...ends) : undefined })
    if (final) grouped.push(final)
    turn = []
  }
  for (const item of items) {
    if (item.kind === 'message' && item.message.role === 'user') flush(item.message.ts ?? Infinity)
    turn.push(item)
  }
  flush()
  return grouped
}

const ActivityBlock: FC<{ entries: ActivityEntry[] }> = ({ entries }) => <>{entries.map((entry, index) => {
  const name = entry.call?.name ?? entry.result?.name ?? 'tool'
  const { Icon } = toolPresentation(name)
  return <details className="assistant-activity" key={entry.call?.id ?? index}>
    <summary><Icon /><ActivityLabel name={name} args={entry.call?.arguments} running={!entry.result} /><ChevronRight className="assistant-activity-caret" /></summary>
    <div className="assistant-activity-body">
      {entry.call?.arguments && <pre className="assistant-activity-args">{JSON.stringify(entry.call.arguments, null, 2)}</pre>}
      {entry.result?.content && <pre className="assistant-activity-output">{entry.result.content}</pre>}
    </div>
  </details>
})}</>

async function copyMessageText(content: string, owner: Document): Promise<boolean> {
  const focused = owner.activeElement as HTMLElement | null
  const field = owner.createElement('textarea')
  field.value = content
  field.style.cssText = 'position:fixed;opacity:0;pointer-events:none;left:0;top:0'
  owner.body.append(field)
  field.select()
  let copied = false
  try { copied = owner.execCommand('copy') } catch { /* Use the async clipboard when supported. */ }
  field.remove()
  focused?.focus({ preventScroll: true })
  if (copied) return true
  try { await owner.defaultView!.navigator.clipboard.writeText(content); return true } catch { return false }
}

const WorkDisclosure: FC<{ summary: React.ReactNode; children: React.ReactNode }> = ({ summary, children }) => {
  const [open, setOpen] = React.useState(false)
  return <details className="assistant-activity-group" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{summary}</summary>
    {open && children}
  </details>
}

const BubbleContent: FC<{ content: string; className?: string }> = ({ content, className }) => (
  <div className="assistant-bubble-md">
    <api.ui.MarkdownView value={content} context={{}} className={className} />
  </div>
)

export function formatSendTime(ts: number, dateFormat: string, timeFormat: '24h' | '12h', now = new Date()): { label: string; full: string } {
  const date = new Date(ts)
  if (!Number.isFinite(date.getTime())) return { label: '', full: '' }
  const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const formattedDate = formatIsoDateByPattern(iso, dateFormat)
  const time = new Intl.DateTimeFormat(api.ui.language(), { hour: timeFormat === '12h' ? 'numeric' : '2-digit', minute: '2-digit', hour12: timeFormat === '12h' }).format(date)
  const full = `${formattedDate} · ${time}`
  return { label: date.toDateString() === now.toDateString() ? time : full, full }
}

/** Copy button + send time revealed on hover under a message (either side). */
const MessageMeta: FC<{ content: string; ts?: number; showTime: boolean }> = ({ content, ts, showTime }) => {
  const [copied, setCopied] = React.useState(false)
  const copy = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    void copyMessageText(content, event.currentTarget.ownerDocument).then((copied) => {
      if (!copied) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [content])
  const dateFormat = React.useSyncExternalStore(api.subscribe, () => api.getState().dateFormat)
  const timeFormat = React.useSyncExternalStore(api.subscribe, () => api.getState().timeFormat)
  const formatted = ts == null ? null : formatSendTime(ts, dateFormat, timeFormat)
  return (
    <div className="assistant-msg-meta">
      <button
        type="button"
        className="assistant-copy-btn"
        onClick={copy}
        title={uiText('auto.26902efda37d')}
        aria-label={uiText('auto.26902efda37d')}
      >
        {copied ? <Check className="assistant-copy-icon" /> : <Copy className="assistant-copy-icon" />}
      </button>
      {showTime && ts != null && formatted?.full && <time className="assistant-msg-time" dateTime={new Date(ts).toISOString()} title={formatted?.full}>{formatted?.label}</time>}
    </div>
  )
}

/** One message row: user / assistant text. */
const MessageRow: FC<{ message: AiMessage; showMeta?: boolean; copyText?: string; showTime: boolean }> = ({
  message,
  showMeta,
  copyText,
  showTime
}) => {
  if (message.role === 'tool') return <ActivityBlock entries={[{ result: message }]} />
  if (message.role === 'system') return null
  const mine = message.role === 'user'
  const content = message.displayContent ?? message.content
  return (
    <div className={`assistant-msg ${mine ? 'mine' : 'theirs'}`}>
      <MessageAttachments files={message.attachmentFiles} />
      {content && (message.error ? <ErrorNotice error={content} /> : <div className="assistant-bubble"><BubbleContent content={content} className="assistant-message-markdown" /></div>)}
      {showMeta && <MessageMeta content={copyText ?? content} ts={message.ts} showTime={showTime} />}
    </div>
  )
}

/**
 * The copy + timestamp row belongs only at the *end of each assistant turn* —
 * one per response, not after every interim message. A turn ends at the last
 * assistant message before the next user message (or the conversation end); its
 * copy yields the whole turn's text. Returns, per render-item index, the joined
 * turn text (or undefined when that item is not a turn end).
 */
function turnEndCopyText(items: RenderItem[]): (string | undefined)[] {
  const out: (string | undefined)[] = items.map(() => undefined)
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind !== 'message' || it.message.role !== 'assistant') continue
    let isEnd = true
    for (let j = i + 1; j < items.length; j++) {
      const nx = items[j]
      if (nx.kind === 'message' && nx.message.role === 'user') break
      if (nx.kind === 'message' && nx.message.role === 'assistant') {
        isEnd = false
        break
      }
    }
    if (!isEnd) continue
    // Gather this turn's assistant text: walk back to the previous user message.
    const parts: string[] = []
    for (let k = i; k >= 0; k--) {
      const m = items[k]
      if (m.kind === 'message' && m.message.role === 'user') break
      if (m.kind === 'message' && m.message.role === 'assistant' && (m.message.displayContent ?? m.message.content)) parts.unshift(m.message.displayContent ?? m.message.content)
    }
    if (parts.length) out[i] = parts.join('\n\n')
  }
  return out
}

/** Claude-style "the model is responding" indicator (pure-CSS, no rAF). */
const ThinkingIndicator: FC<{ phase: 'thinking' | 'working' }> = ({ phase }) => (
  <div className="assistant-run-status" role="status">
    <span className="assistant-run-label">
      {phase === 'working' ? uiText('auto.3b4dfc971393') : uiText('auto.d08d8da0b3e1')}
      <span className="assistant-think-dots" aria-hidden="true" />
    </span>
  </div>
)

function ComposerPopover({ anchor, label, role = 'dialog', onClose, children }: {
  anchor: HTMLElement
  label: string
  role?: 'dialog' | 'menu'
  onClose(): void
  children: ReactNode
}): React.ReactElement {
  const popover = React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(() => {
    const element = popover.current
    const Observer = element?.ownerDocument.defaultView?.ResizeObserver
    if (!element || !Observer) return
    // Host widgets cut their occlusion holes from the popover's box; re-announce it whenever its size changes.
    const observer = new Observer(() => element.setAttribute('data-plugin-widget-occluder', ''))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return <>
    <div className="assistant-popover-dismiss" onPointerDown={onClose} />
    <div ref={popover} className="assistant-composer-popover" data-plugin-widget-occluder="" role={role} aria-label={label} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); anchor.focus() }
    }}>{children}</div>
  </>
}

function QueuedMessage({ item, onEdit, onRemove, onSteer, store }: { store: ReturnType<typeof useAssistant>['store']; item: import('./types').PendingMessage; onEdit(text: string): Promise<void>; onRemove(): Promise<void>; onSteer(): Promise<void> }): React.ReactElement {
  const [editing, setEditing] = React.useState(false)
  const [text, setText] = React.useState(item.text)
  const [error, setError] = React.useState('')
  const act = (work: Promise<void>): void => { void work.catch(error => setError(String(error))) }
  React.useEffect(() => () => store.setQueueEditing(item.id, false), [store, item.id])
  const finish = (): void => { setEditing(false); store.setQueueEditing(item.id, false) }
  const save = (): void => act(onEdit(text).then(finish))
  return <div className="assistant-queued-message">
    {editing ? <form onSubmit={event => { event.preventDefault(); save() }}>
      <textarea autoFocus aria-label={uiText('assistant.queue.edit')} value={text} onChange={event => setText(event.target.value)} />
      <button type="button" className="assistant-iconbtn" aria-label={uiText('assistant.queue.save')} onClick={save}><Check /></button>
      <button type="button" className="assistant-iconbtn" aria-label={uiText('assistant.project.cancel')} onClick={finish}><X /></button>
    </form> : <><span className="assistant-queued-text">{item.text || item.attachments?.map(attachment => attachment.fileName).join(', ')}</span>
      <button className="assistant-iconbtn" aria-label={uiText('assistant.queue.edit')} title={uiText('assistant.queue.edit')} onClick={() => { store.setQueueEditing(item.id, true); setText(item.text); setEditing(true) }}><Pencil /></button>
      <button className="assistant-iconbtn" aria-label={uiText('assistant.queue.steer')} title={uiText('assistant.queue.steer')} onClick={() => act(onSteer())}><Steer /></button>
      <button className="assistant-iconbtn" aria-label={uiText('assistant.queue.remove')} title={uiText('assistant.queue.remove')} onClick={() => act(onRemove())}><X /></button></>}
    {error && <span role="alert">{error}</span>}
  </div>
}

export const PermissionControl: FC<{ disabled?: boolean; onChanged(): void }> = ({ disabled, onChanged }) => {
  const wrapper = React.useRef<HTMLDivElement>(null)
  const [iconOnly, setIconOnly] = React.useState(false)
  React.useLayoutEffect(() => {
    const page = wrapper.current?.closest('.assistant-page')
    if (!page || typeof ResizeObserver === 'undefined') return
    const update = (): void => setIconOnly(page.getBoundingClientRect().width <= 460)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(page)
    return () => observer.disconnect()
  }, [])
  return <div className="assistant-perm" ref={wrapper} onMouseDown={event => event.stopPropagation()}>
    <api.ui.AccessControl variant="compact" iconOnly={iconOnly} disabled={disabled} onChange={onChanged} />
  </div>
}

export function ModelPicker({ options, value, onSelect }: {
  options: { value: string; label: string; description: string }[]
  value: string
  onSelect(value: string): void
}): React.ReactElement {
  const [query, setQuery] = React.useState('')
  const searchable = options.length > 8
  const filtered = searchable ? options.filter(option => `${option.label} ${option.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) : options
  const move = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    if ((event.target as HTMLElement).tagName === 'INPUT' && event.key !== 'ArrowDown') return
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'))
    if (!buttons.length) return
    event.preventDefault()
    const current = buttons.indexOf(event.target as HTMLButtonElement)
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[index]?.focus()
  }
  return <div className="assistant-model-menu" onKeyDown={move}>
    <p className="assistant-composer-menu-title">{uiText('assistant.composer.model')}</p>
    {searchable && <div className="search-field-row"><input className="search-field" autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder={uiText('assistant.composer.searchModels')} aria-label={uiText('assistant.composer.searchModels')} /></div>}
    <div className="assistant-model-options" role="listbox" aria-label={uiText('assistant.composer.model')}>
      {filtered.map(option => <button key={option.value} role="option" aria-selected={option.value === value} className="assistant-model-option" autoFocus={!searchable && option.value === value} title={option.description} onClick={() => onSelect(option.value)}>
        <span><strong>{option.label}</strong>{(option.value === 'auto' || options.some(other => other.value !== option.value && other.label === option.label)) && <small>{option.description}</small>}</span>{option.value === value && <Check />}
      </button>)}
      {filtered.length === 0 && <p className="assistant-model-empty" role="status">{uiText('assistant.composer.noModels')}</p>}
    </div>
  </div>
}

export function EffortPicker({ value, supported, modelLabel, onChange, onModels }: {
  value?: ReasoningEffort
  supported: ReasoningEffort[]
  modelLabel: string
  onChange(value?: ReasoningEffort): void
  onModels(): void
}): React.ReactElement {
  const current = value && supported.includes(value) ? value : undefined
  const sliderIndex = Math.max(0, supported.indexOf(current ?? 'high'))
  return <div className="assistant-effort-menu">
    <div className="assistant-effort-heading">
      <Lightning />
      <strong>{uiText(current ? `assistant.effort.${current}` : 'assistant.effort.default')}</strong>
      <button type="button" className="assistant-effort-reset" aria-label={uiText('assistant.effort.reset')} title={uiText('assistant.effort.reset')} disabled={!current} onClick={() => onChange(undefined)}><Reset /></button>
    </div>
    <button type="button" className="assistant-effort-model" autoFocus onClick={onModels} aria-label={uiText('assistant.composer.model')}>{modelLabel}<ChevronRight /></button>
    {supported.length ? <>
      <input className="assistant-effort-slider" type="range" min={0} max={supported.length - 1} step={1}
        aria-label={uiText('assistant.effort.label')} aria-valuetext={uiText(current ? `assistant.effort.${current}` : 'assistant.effort.default')}
        value={sliderIndex} onChange={event => onChange(supported[Number(event.target.value)])}
        style={{ '--slider-fill': `${sliderIndex / Math.max(1, supported.length - 1) * 100}%` } as React.CSSProperties} />
      <div className="assistant-effort-levels">{supported.map(effort => <button key={effort} type="button" disabled={!supported.includes(effort)} aria-pressed={current === effort} onClick={() => onChange(effort)}>{uiText(`assistant.effort.${effort}`)}</button>)}</div>
    </> : <p className="assistant-effort-unavailable">{uiText('assistant.effort.unavailable')}</p>}
  </div>
}

/** The full agent chat — main workspace tab. */
export const Page: FC<MainWorkspaceViewProps> = ({ navigation }) => <ChatView navigation={navigation} />

export const ChatView: FC<{ navigation?: MainWorkspaceViewProps['navigation']; sidebar?: { onBack(): void; onProperties(): void } }> = ({ navigation, sidebar }) => {
  const { store, snap } = useAssistant()
  const activity = useToolActivity(snap.active?.id)
  React.useEffect(() => {
    if (!navigation) return
    navigation.setController({
      canGoBack: snap.canGoBack,
      canGoForward: snap.canGoForward,
      goBack: () => store.goBack(),
      goForward: () => store.goForward()
    })
    return () => navigation.setController(null)
  }, [navigation, snap.canGoBack, snap.canGoForward, store])
  // The host's styled dropdown — never a raw `<select>`, whose popup Chromium
  // hands to the OS unthemed and which ignores the native/custom menu setting.
  const [, refreshDraft] = React.useReducer(value => value + 1, 0)
  const draftId = snap.active?.id ?? ''
  const { text: draft, attachments } = store.getDraft(draftId)
  const setDraft = React.useCallback((text: string): void => { store.setDraft(draftId, text, store.getDraft(draftId).attachments); refreshDraft() }, [draftId, store])
  const setAttachments = React.useCallback((value: InboundAttachment[] | ((current: InboundAttachment[]) => InboundAttachment[])): void => {
    const current = store.getDraft(draftId)
    store.setDraft(draftId, current.text, typeof value === 'function' ? value(current.attachments) : value)
    refreshDraft()
  }, [draftId, store])
  const [modelListOpen, setModelListOpen] = React.useState(false)
  const [modelAnchor, setModelAnchor] = React.useState<HTMLButtonElement | null>(null)
  const [scrollRequest, requestScroll] = React.useReducer(value => value + 1, 0)
  const bodyRef = React.useRef<HTMLDivElement | null>(null)
  const [awayFromBottom, setAwayFromBottom] = React.useState(false)
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null)
  // Composer behaviour lives in Settings → Assistant → Chat.
  const sendOnEnter = usePluginSetting('sendOnEnter', true)
  const showTimestamps = usePluginSetting('showTimestamps', true)
  const attachFolder = usePluginSetting('attachmentFolder', '')

  const messages = React.useMemo(() => snap.active?.messages ?? [], [snap.active?.messages])
  const renderItems = React.useMemo(() => buildRenderItems(messages, activity.steps), [messages, activity.steps])
  const turnCopy = React.useMemo(() => turnEndCopyText(renderItems), [renderItems])
  const stoppedWork = snap.stopped && !snap.activeBusy ? renderItems.reduce((last, item, index) => item.kind === 'activity' ? index : item.message.role === 'user' ? -1 : last, -1) : -1
  const source = snap.active?.source
  const readOnly = Boolean(source)
  const { channels, error: channelError } = useChannels()
  const channel = channels.find(value => value.id === snap.active?.channelId)
  const connected = Boolean(channel?.connected && channel.running && !channel.error && !channelError)
  const connectionLabel = connected ? uiText('assistant.channel.connected') : channelError || channel?.error || uiText('assistant.channel.notConfigured')
  const RemoteIcon = source === 'whatsapp' ? WhatsApp : Telegram
  const remoteLabel = source === 'whatsapp' ? 'WhatsApp' : uiText('auto.edbea9ff1a78')
  const remoteIconClass = source === 'whatsapp' ? 'assistant-wa-ico' : 'assistant-tg-ico'

  const danger = Boolean(snap.dangerous?.enabled)
  const fitInput = React.useCallback((el = inputRef.current): void => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [])

  React.useLayoutEffect(() => {
    fitInput()
  }, [draft, fitInput])

  const jumpToLatest = (): void => {
    requestScroll()
    inputRef.current?.focus({ preventScroll: true })
  }

  const [attachmentError, setAttachmentError] = React.useState('')
  const [dropping, setDropping] = React.useState(false)
  const dragDepth = React.useRef(0)
  const clearDrop = React.useCallback(() => { dragDepth.current = 0; setDropping(false) }, [])
  React.useEffect(() => {
    clearDrop()
    const doc = bodyRef.current?.ownerDocument
    if (!doc) return
    const cancel = (event: KeyboardEvent): void => { if (event.key === 'Escape') clearDrop() }
    doc.addEventListener('dragend', clearDrop)
    doc.addEventListener('drop', clearDrop, true)
    doc.addEventListener('keydown', cancel)
    return () => {
      doc.removeEventListener('dragend', clearDrop)
      doc.removeEventListener('drop', clearDrop, true)
      doc.removeEventListener('keydown', cancel)
    }
  }, [draftId, clearDrop])
  const [attaching, setAttaching] = React.useState(false)
  const [slashIndex, setSlashIndex] = React.useState(0)
  const [slashDismissed, setSlashDismissed] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  const addFiles = React.useCallback(async (files: FileList | File[]): Promise<void> => {
    const list = Array.from(files)
    if (!list.length) return
    setAttachmentError(''); setAttaching(true)
    try {
      for (const file of list) {
        const kind = attachmentKind(file)
        if (!kind) continue // skip unsupported (video)
        if (file.size > Number(api.settings.get().importMaxBytes ?? 32 * 1024 * 1024)) throw new Error(uiText('assistant.attachmentTooLarge'))
        const id = await api.backend.call<string>('attachments.begin', { fileName: file.name, kind, mime: file.type || undefined, folder: attachFolder })
        try {
          for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
            const base64 = await fileToBase64(file.slice(offset, offset + 1024 * 1024))
            await api.backend.call('attachments.chunk', { id, offset, base64 })
          }
          const attachment = await api.backend.call<InboundAttachment>('attachments.finish', { id, bytes: file.size })
          setAttachments(current => [...current, attachment])
        } catch (error) { await api.backend.call('attachments.abort', { id }).catch(() => undefined); throw error }
      }
    } catch (error) { setAttachmentError(String(error)) } finally {
      setAttaching(false)
    }
  }, [attachFolder, setAttachments])

  const submit = (): void => {
    const text = draft.trim()
    if ((!text && attachments.length === 0) || attaching) return
    const atts = attachments
    setDraft('')
    setAttachments([])
    void store.send(text, atts.length ? atts : undefined).catch(error => setAttachmentError(String(error)))
  }

  const slashCommands: SlashCommand[] = [{ id: 'plan', label: uiText('assistant.plan.label'), description: uiText('assistant.plan.description'), run: () => { void store.startPlanning().catch(error => setAttachmentError(String(error))) } }]
  const slashQuery = /^\/[\w-]*$/.test(draft) ? draft.slice(1).toLowerCase() : null
  const slashMatches = slashQuery === null ? [] : slashCommands.filter(command => `${command.id} ${command.label}`.toLowerCase().includes(slashQuery))
  const slashOpen = !slashDismissed && slashMatches.length > 0
  const chooseSlash = (command: SlashCommand): void => { setDraft(''); setSlashDismissed(true); command.run(); inputRef.current?.focus() }
  const composerKeyDown = (e: React.KeyboardEvent, send: () => void): void => {
    if (e.nativeEvent.isComposing) return
    if (slashOpen) {
      if (e.key === 'Escape') { e.preventDefault(); setSlashDismissed(true); return }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((slashIndex + (e.key === 'ArrowDown' ? 1 : -1) + slashMatches.length) % slashMatches.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); chooseSlash(slashMatches[Math.min(slashIndex, slashMatches.length - 1)]); return }
    }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    const wantsSend = sendOnEnter ? !e.shiftKey && !api.ui.hasModKey(e) : api.ui.hasModKey(e)
    if (!wantsSend) return
    e.preventDefault()
    send()
  }

  const overrideValue = modelValue(snap.active?.model) || 'auto'
  const connections = snap.config?.connections ?? []
  let effortModel = snap.active?.model
  if (!effortModel && snap.config) {
    try { effortModel = route({ text: draft, connections }, snap.config.routing) } catch { /* No eligible model yet. */ }
  }
  const availableEfforts = supportedEfforts(effortModel, connections)
  const selectedEffort = snap.active?.reasoningEffort && availableEfforts.includes(snap.active.reasoningEffort) ? snap.active.reasoningEffort : undefined
  const selectedConnection = connections.find(connection => connection.id === (snap.active?.model?.connectionId ?? snap.active?.model?.provider) && connection.provider === snap.active?.model?.provider)
  const selectedModelInfo = selectedConnection?.models.find(model => model.id === snap.active?.model?.model)
  const unavailableModel = Boolean(snap.active?.model && (!selectedConnection?.configured || !selectedModelInfo))
  const modelName = selectedModelInfo?.label || snap.active?.model?.model || uiText('auto.c614ba7c453c')
  const selectedModelLabel = unavailableModel ? `${modelName} · ${uiText('assistant.composer.modelUnavailable')}` : modelName

  const dragHandlers = {
    onDragEnter: (event: React.DragEvent<HTMLDivElement>) => {
      if (readOnly || !Array.from(event.dataTransfer.types).includes('Files')) return
      event.preventDefault(); event.stopPropagation()
      dragDepth.current += 1
      setDropping(true)
    },
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
      if (readOnly || !Array.from(event.dataTransfer.types).includes('Files')) return
      event.preventDefault(); event.stopPropagation()
      event.dataTransfer.dropEffect = 'copy'
      setDropping(true)
    },
    onDragLeave: (event: React.DragEvent<HTMLDivElement>) => {
      if (!dragDepth.current) return
      event.stopPropagation()
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (!dragDepth.current) setDropping(false)
    },
    onDrop: (event: React.DragEvent<HTMLDivElement>) => {
      if (readOnly || !event.dataTransfer.files.length) return
      event.preventDefault(); event.stopPropagation()
      clearDrop()
      void addFiles(event.dataTransfer.files)
    },
  }

  return (
    <div className="assistant-page" aria-busy={!snap.ready}>
      <div className={`assistant-page-head${sidebar ? ' assistant-mobile-chat-head' : ''}`}>
        {sidebar && <button className="assistant-iconbtn" aria-label={uiText('assistant.mobile.back')} title={uiText('assistant.mobile.back')} onClick={sidebar.onBack}><ChevronLeft /></button>}
        {readOnly && !sidebar && <RemoteIcon className={`assistant-page-source-icon ${remoteIconClass}`} />}
        <div className="assistant-page-title-wrap">
          <div className="assistant-page-title">
            {snap.active?.title ?? uiText('auto.8010d1f4d069')}
          </div>
          {readOnly && <div className="assistant-page-subtitle">{remoteLabel} {uiText('auto.ffff80d25a26')}</div>}
        </div>
        {sidebar ? <div className="assistant-mobile-chat-actions">
          <button className="assistant-iconbtn" aria-label={uiText('assistant.mobile.settings')} title={uiText('assistant.mobile.settings')} onClick={sidebar.onProperties}><LuSettings /></button>
        </div> : readOnly && <span className={`assistant-connection-indicator${connected ? ' is-connected' : ''}`} role="status" aria-label={connectionLabel} title={connectionLabel} />}
      </div>

      <div className="assistant-chat-body" ref={bodyRef}
        {...dragHandlers}
      >
      <div className="assistant-messages" data-plugin-widget-layout="fill">
      <api.ui.ScrollPanel fill followEnd scrollToEndKey={`${draftId}:${scrollRequest}`} onAtEndChange={atEnd => setAwayFromBottom(!atEnd)}>
      <div className="assistant-message-content" {...dragHandlers}>
        {activity.error && <ErrorNotice error={activity.error} />}
        {snap.error && !messages.some(message => message.error && (message.content === snap.error || message.failure === snap.error)) && <ErrorNotice error={snap.error} />}
        {messages.length === 0 && !snap.streaming && !readOnly && (
          <div className="assistant-welcome">
            <div className="assistant-welcome-mark"><Chat />{uiText('manifest.name')}</div>
            <h2>{uiText('assistant.welcome.title')}</h2>
            <p>{uiText(snap.active?.projectId ? 'assistant.welcome.project' : 'assistant.welcome.description')}</p>
            <div className="assistant-starters">
              {([{ key: 'explore', Icon: Folder }, { key: 'write', Icon: Pencil }, { key: 'plan', Icon: Check }] as const).map(({ key, Icon }) => (
                <button key={key} className="assistant-starter" disabled={Boolean(draft.trim()) || snap.activeBusy} onClick={() => {
                  setDraft(uiText(`assistant.welcome.${key}Prompt`))
                  inputRef.current?.focus()
                }}><Icon /><span>{uiText(`assistant.welcome.${key}`)}</span></button>
              ))}
            </div>
          </div>
        )}
        {renderItems.map((item, i) =>
          item.kind === 'message' ? (
            <MessageRow
              key={i}
              message={item.message}
              showMeta={item.message.role === 'user' || (turnCopy[i] != null && (!snap.activeBusy || i < renderItems.length - 1))}
              copyText={turnCopy[i]}
              showTime={showTimestamps}
            />
          ) : (
            <WorkDisclosure key={i} summary={<><WorkDuration startedAt={item.startedAt} endedAt={item.endedAt} running={snap.activeBusy && !renderItems.slice(i + 1).some(next => next.kind === 'message' && next.message.role === 'user')} /><ChevronRight className="assistant-activity-caret" />{stoppedWork === i && <span className="assistant-work-stopped" role="status">{uiText('assistant.run.stopped')}</span>}</>}>
              <api.ui.ScrollPanel maxHeight={340} bodyClassName="assistant-activity-group-body"><div tabIndex={0} role="region" aria-label={uiText('assistant.activity.timeline')}><ol className="assistant-work-timeline">{item.entries.map((entry, index) => <li key={entry.step ? `${entry.step.runId}:${entry.step.callId}` : index}>{entry.message
                ? <div className="assistant-activity-commentary" key={index}><BubbleContent content={entry.message.displayContent ?? entry.message.content} /></div>
                : entry.step && snap.active
                  ? <ToolActivityRow key={`${entry.step.runId}:${entry.step.callId}`} step={entry.step} steps={activity.steps} chatId={snap.active.id} expandAll={false} onStop={() => store.stop(snap.active?.id)} />
                  : <ActivityBlock key={index} entries={[entry]} />}</li>)}</ol></div></api.ui.ScrollPanel>
            </WorkDisclosure>
          )
        )}
        {snap.streaming && snap.streamingText && (
          <div className="assistant-msg theirs">
            <div className="assistant-bubble assistant-streaming">
              {snap.streamingText}
              <span className="assistant-stream-caret" aria-hidden="true" />
            </div>
          </div>
        )}
        {snap.streaming && !snap.streamingText && !snap.pending && <ThinkingIndicator phase={snap.phase} />}

        {snap.pending && <div className="assistant-run-status" role="status"><Hand />{uiText('assistant.run.approval')}</div>}
        {snap.pending && (
          <ApprovalCard request={snap.pending} onRespond={(a) => store.respond(snap.pending!.requestId, a)} />
        )}

        {!readOnly && snap.active?.quiz && (
          <div className="assistant-quiz-choices">
            {snap.active.quiz.choices.map((c) => (
              <button
                key={c.value}
                className="assistant-btn assistant-btn-ghost"
                disabled={snap.activeBusy}
                onClick={() => void store.answerQuiz(c.value)}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
      </div>
      </api.ui.ScrollPanel>
      </div>

      <div className="assistant-composer-dock">
      {snap.stopped && !snap.activeBusy && stoppedWork < 0 && <div className="assistant-composer-status" role="status">{uiText('assistant.run.stopped')}</div>}
      {!readOnly && slashOpen && <SlashMenu commands={slashMatches} selected={Math.min(slashIndex, slashMatches.length - 1)} onSelect={chooseSlash} />}
      {!readOnly && snap.active?.mode === 'plan' && snap.active.plan?.status === 'review' && !snap.activeBusy && <div className="assistant-plan-review" role="group" aria-label={uiText('assistant.plan.review')}>
        <span>{uiText('assistant.plan.review')}</span>
        {snap.active.plan.directory && <span>{['plan.md', 'tasks.md', 'acceptance.md', 'decisions.md'].map(name => <button className="assistant-btn assistant-btn-ghost" key={name} onClick={() => api.workspace.openFile(`${snap.active!.plan!.directory}/${name}`)}>{name}</button>)}</span>}
        <button className="assistant-btn assistant-btn-ghost" onClick={() => { void store.changePlan(snap.active!.plan!.id).then(() => inputRef.current?.focus()).catch(error => setAttachmentError(String(error))) }}>{uiText('assistant.plan.change')}</button>
        <button className="assistant-btn" onClick={() => { void store.implementPlan(snap.active!.plan!.id).catch(error => setAttachmentError(String(error))) }}>{uiText('assistant.plan.implement')}</button>
      </div>}
      {awayFromBottom && <button type="button" className="assistant-jump-latest" data-plugin-widget-occluder="" title={uiText('assistant.scroll.latest')} aria-label={uiText('assistant.scroll.latest')} onClick={jumpToLatest}><ArrowDown /></button>}
      {readOnly ? (
        <div className="assistant-channel-banner" role="status">
          <RemoteIcon className={remoteIconClass} />
          <div><span>{channel?.name || snap.active?.channelName || remoteLabel} · {connectionLabel}</span><span>{uiText('assistant.channel.readOnly', { channel: remoteLabel })}</span></div>
        </div>
      ) : (
        <div
          className={`assistant-composer${snap.streaming ? ' is-streaming' : ''}${danger ? ' is-dangerous' : ''}`}
        >
          {attachmentError && <ErrorNotice error={attachmentError} />}
          {attachments.length > 0 && (
            <div className="assistant-attach-chips">
              {attachments.map((a, i) => (
                <span className="assistant-attach-chip" key={a.path}>
                  {a.kind === 'image' ? <img src={assetUrlForRelPath(a.path)} alt={a.fileName} /> : <Folder />}
                  <span title={a.fileName}>{a.fileName}</span>
                  <button title={uiText('auto.e963907dac5c')} onClick={() => { if (a.id) void api.backend.call('attachments.discard', { id: a.id }).catch(error => setAttachmentError(String(error))); setAttachments((list) => list.filter((_, j) => j !== i)) }}>
                    <X className="" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {Boolean(snap.active?.pendingMessages?.length) && <div className="assistant-queue" aria-label={uiText('assistant.queue.title')}>
            <div className="assistant-queue-heading"><Queue /><span>{uiText(snap.queuePaused ? 'assistant.queue.paused' : 'assistant.queue.title')}</span>
              {snap.queuePaused && <button className="assistant-btn assistant-btn-ghost" onClick={() => void store.resumeQueue()}>{uiText('assistant.queue.resume')}</button>}
            </div>
            {snap.active!.pendingMessages!.map(item => <QueuedMessage key={item.id} store={store} item={item} onEdit={text => store.editQueued(item.id, text)} onRemove={() => store.removeQueued(item.id)} onSteer={() => store.steerQueued(item.id)} />)}
          </div>}
          <textarea
            ref={inputRef}
            className="assistant-composer-input"
            aria-label={uiText('assistant.composer.message')}
            placeholder={uiText(snap.activeBusy ? 'assistant.composer.followUp' : snap.active?.mode === 'plan' ? snap.active.plan?.status === 'changes' ? 'assistant.plan.changesPlaceholder' : 'assistant.plan.placeholder' : 'auto.24bf2a34e6f4')}
            aria-controls={slashOpen ? 'assistant-slash-menu' : undefined}
            aria-activedescendant={slashOpen ? `assistant-slash-${slashMatches[Math.min(slashIndex, slashMatches.length - 1)].id}` : undefined}
            rows={1}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setSlashDismissed(false); setSlashIndex(0)
              fitInput(e.currentTarget)
            }}
            onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); void addFiles(event.clipboardData.files) } }}
            onKeyDown={(e) => composerKeyDown(e, submit)}
          />
          <div className="assistant-composer-toolbar">
            <div className="assistant-composer-left">
              <button
                className="assistant-attach-btn"
                title={uiText('auto.2d6c04901b6c')}
                aria-label={uiText('auto.ae85e4ee1e6c')}
                disabled={attaching}
                onClick={() => fileInputRef.current?.click()}
              >
                <Plus className="" />
              </button>
              <PermissionControl disabled={snap.activeBusy} onChanged={() => { void store.reloadConfig().catch(error => setAttachmentError(String(error))) }} />
              {snap.active?.mode === 'plan' && <span className="assistant-plan-mode" title={uiText('assistant.plan.description')}><ReadBook />{uiText('assistant.plan.label')}</span>}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  if (e.target.files?.length) void addFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </div>
            <div className="assistant-composer-right">
              <div className="assistant-model-wrap">
                <button className="assistant-model-select" type="button" disabled={snap.activeBusy}
                  aria-label={uiText('assistant.composer.model')} aria-haspopup="dialog"
                  title={snap.active?.model?.model ?? uiText('auto.c614ba7c453c')}
                  aria-expanded={Boolean(modelAnchor)} onClick={event => { setModelListOpen(false); setModelAnchor(modelAnchor ? null : event.currentTarget); if (!modelAnchor) void store.reloadConfig().catch(error => setAttachmentError(String(error))) }}
                ><Model /><span>{selectedModelLabel}{selectedEffort && <span className="assistant-model-effort"> {uiText(`assistant.effort.${selectedEffort}`)}</span>}</span><ChevronRight className="assistant-model-chevron" /></button>
                {modelAnchor && <ComposerPopover anchor={modelAnchor} label={uiText('assistant.composer.model')} onClose={() => setModelAnchor(null)}>
                  {!modelListOpen ? <EffortPicker value={selectedEffort} supported={availableEfforts} modelLabel={selectedModelLabel}
                    onChange={effort => store.setReasoningEffort(effort)} onModels={() => setModelListOpen(true)} /> : <div><ModelPicker value={overrideValue} options={[
                    { value: 'auto', label: uiText('auto.c614ba7c453c'), description: uiText('assistant.composer.autoModel') },
                    ...connections.filter(connection => connection.configured).flatMap(connection => connection.models.map(model => ({
                      value: `${connection.id}:${model.id}`, label: model.label || model.id,
                      description: connection.label || connection.providerName || connection.provider
                    })))
                  ]} onSelect={value => {
                    if (value === 'auto') store.setModelOverride(null)
                    else { const selected = parseModelValue(value, connections); if (selected) store.setModelOverride(selected) }
                    setModelListOpen(false)
                  }} /></div>}
                </ComposerPopover>}
              </div>
            </div>
            {snap.activeBusy && (
              <button className="assistant-send-round assistant-send-stop" title={uiText('auto.9e253470c876')} aria-label={uiText('auto.9e253470c876')} onClick={() => store.stop()}>
                <Stop className="" />
              </button>
            )}
            {snap.activeBusy && (draft.trim() || attachments.length > 0) && <button className="assistant-iconbtn assistant-steer" title={uiText('assistant.queue.steer')} aria-label={uiText('assistant.queue.steer')} disabled={attaching} onClick={() => {
              const promise = store.send(draft, attachments.length ? attachments : undefined)
              const item = store.getSnapshot().active?.pendingMessages?.at(-1)
              setDraft(''); setAttachments([])
              if (item) void store.steerQueued(item.id)
              void promise.catch(error => setAttachmentError(String(error)))
            }}><Steer /></button>}
            {(!snap.activeBusy || draft.trim() || attachments.length > 0) && <button
                className="assistant-send-round"
                title={uiText(snap.activeBusy ? 'assistant.queue.add' : 'auto.9bc2575c3930')}
                aria-label={uiText(snap.activeBusy ? 'assistant.queue.add' : 'auto.9bc2575c3930')}
                onClick={submit}
                disabled={(!draft.trim() && attachments.length === 0) || attaching}
              >
                {snap.activeBusy ? <Queue /> : <Send />}
              </button>}
          </div>
        </div>
      )}
      </div>
      {!readOnly && snap.active && <VoiceControls hiddenLauncher requested={snap.voiceConversationId === snap.active.id} onClose={() => store.closeVoice()} conversationId={snap.active.id} executionState={snap.activeBusy ? snap.phase : snap.stopped ? 'cancelled' : snap.error ? 'failed' : snap.active.plan?.status === 'review' ? 'review' : 'idle'} response={(() => { const message = [...(snap.active?.messages ?? [])].reverse().find(message => message.role === 'assistant' && message.content && !message.error && !message.toolCalls?.length); return message?.id && !snap.activeBusy ? { id: message.id, text: message.content } : undefined })()} onTranscript={({ id, text }) => store.send(text, undefined, id, 'voice')} onError={setAttachmentError} onInterrupted={() => store.interruptVoice()} />}
      {dropping && !readOnly && <div className="assistant-drop-overlay" role="status"><span>{uiText('assistant.attachment.drop')}</span></div>}
      </div>
    </div>
  )
}
