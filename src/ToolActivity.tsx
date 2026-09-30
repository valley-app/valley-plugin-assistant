import type { ProjectActivity } from '@valley/plugin-sdk/pluginExecution'
import { api, React } from './runtime'
import { Tool, Warning, ReadBook, Terminal, Pencil, ChevronRight, Stopwatch } from './icons'
import { uiText } from './localization'
export function formatWorkDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  const remainder = seconds % 60
  return [hours ? uiText('assistant.activity.hours', { count: hours }) : '', minutes || hours ? uiText('assistant.activity.minutes', { count: minutes }) : '', uiText('assistant.activity.seconds', { count: remainder })].filter(Boolean).join(' ')
}

export function WorkDuration({ startedAt, endedAt, running }: { startedAt?: number; endedAt?: number; running: boolean }): React.ReactElement {
  const ref = React.useRef<HTMLSpanElement>(null)
  const [now, setNow] = React.useState(Date.now)
  React.useEffect(() => {
    const owner = ref.current?.ownerDocument
    const view = owner?.defaultView
    if (!running || startedAt == null || !owner || !view) return
    let timer: number | undefined
    const update = () => setNow(Date.now())
    const sync = () => {
      view.clearInterval(timer)
      timer = undefined
      if (owner.visibilityState !== 'hidden') { update(); timer = view.setInterval(update, 1000) }
    }
    sync()
    owner.addEventListener('visibilitychange', sync)
    return () => { view.clearInterval(timer); owner.removeEventListener('visibilitychange', sync) }
  }, [running, startedAt])
  const end = running ? now : endedAt
  const duration = startedAt != null && end != null ? formatWorkDuration(end - startedAt) : undefined
  return <span className="assistant-work-duration" ref={ref}><Stopwatch /><span>{uiText(duration ? running ? 'assistant.activity.workingFor' : 'assistant.activity.workedFor' : running ? 'assistant.activity.working' : 'assistant.activity.worked', { duration })}</span></span>
}

export function toolPresentation(name: string, args: Record<string, unknown> = {}, running = false) {
  const category = /command|shell|terminal|exec/.test(name) ? 'command'
    : /search|find/.test(name) ? 'search'
      : /write|edit|patch|create|delete|rename/.test(name) ? 'edit'
        : /read|list|open|inspect/.test(name) ? 'read' : 'other'
  const path = typeof args.path === 'string' ? args.path : typeof args.relPath === 'string' ? args.relPath : ''
  const detail = category === 'command' ? String(args.command ?? args.id ?? args.cmd ?? name)
    : path || String(args.query ?? args.pattern ?? name.replace(/[_-]+/g, ' '))
  return { category, path, detail, label: uiText(`assistant.activity.${category}.${running ? 'active' : 'done'}`), Icon: category === 'command' ? Terminal : category === 'edit' ? Pencil : category === 'other' ? Tool : ReadBook }
}

export function activitySummary(names: string[]): string {
  const categories = [...new Set(names.map(name => toolPresentation(name).category))]
  return categories.map(category => uiText(`assistant.activity.summary.${category}`)).join(', ')
}

export function ActivityLabel({ name, args, running = false }: { name: string; args?: Record<string, unknown>; running?: boolean }): React.ReactElement {
  const { label, detail, path } = toolPresentation(name, args, running)
  const canOpen = path && !path.startsWith('/') && !path.split('/').includes('..') && /\.[^/]+$/.test(path)
  return <span className="assistant-activity-label"><span>{label}</span>{' '}{canOpen
    ? <button className="assistant-activity-file" title={path} onClick={event => { event.preventDefault(); event.stopPropagation(); api.workspace.openFile(path) }}>{path.split('/').at(-1)}</button>
    : <span className="assistant-activity-detail" title={detail}>{detail}</span>}</span>
}

export interface ActivityStep extends ProjectActivity { startedAt: number }
const key = (event: ProjectActivity) => `${event.runId}:${event.callId}`
export function useToolActivity(chatId?: string): { steps: ActivityStep[]; error: string } {
  const [activity, setActivity] = React.useState<{ chatId?: string; steps: ActivityStep[]; error: string }>({ chatId, steps: [], error: '' })
  React.useEffect(() => {
    let current = true, loading = true
    const rows = new Map<string, ActivityStep>(), buffered: ProjectActivity[] = []
    const add = (event: ProjectActivity) => { const previous = rows.get(key(event)); rows.set(key(event), { ...previous, ...event, startedAt: previous?.startedAt ?? event.timestamp }) }
    const publish = (error = '') => setActivity({ chatId, steps: [...rows.values()], error })
    publish()
    const off = api.backend.on('activity', value => {
      const message = value as { chatId: string; event: ProjectActivity }
      if (!current || message.chatId !== chatId) return
      if (loading) buffered.push(message.event)
      else { add(message.event); publish() }
    })
    if (chatId) void (async () => {
      let offset = 0
      for (;;) {
        const page = await api.backend.call<{ events: ProjectActivity[]; nextOffset: number; done: boolean }>('activity.request', { method: 'list', payload: { chatId, offset } })
        if (!current) return
        for (const event of page.events) add(event)
        if (page.done) break
        if (page.nextOffset <= offset) throw new Error('Activity loading stalled')
        offset = page.nextOffset
      }
      for (const event of buffered) add(event)
      loading = false
      publish()
    })().catch(error => { if (current) { loading = false; for (const event of buffered) add(event); publish(String(error)) } })
    return () => { current = false; off() }
  }, [chatId])
  return activity.chatId === chatId ? { steps: activity.steps, error: activity.error } : { steps: [], error: '' }
}
function Output({ chatId, reference, revision }: { chatId: string; reference: string; revision: number }): React.ReactElement {
  const [text, setText] = React.useState(''), [offset, setOffset] = React.useState(0), [done, setDone] = React.useState(false), [pending, setPending] = React.useState(false), [error, setError] = React.useState('')
  const decoder = React.useRef(new TextDecoder())
  const active = React.useRef(true)
  React.useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const load = async (): Promise<void> => {
    setPending(true)
    try {
      const result = await api.backend.call<{ base64: string; done: boolean; nextOffset: number }>('activity.request', { method: 'readOutput', payload: { chatId, outputRef: reference, offset } })
      if (!active.current) return
      const bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0))
      setText(text => text + decoder.current.decode(bytes, { stream: !result.done })); setOffset(result.nextOffset); setDone(result.done)
    } catch (error) { if (active.current) setError(String(error)) } finally { if (active.current) setPending(false) }
  }
  const seen = React.useRef(-1)
  React.useEffect(() => {
    if (!pending && seen.current !== revision && (done || offset === 0)) { seen.current = revision; void load() }
  }, [revision, pending, done, offset])
  return <div>{text && <pre className="assistant-activity-output">{text}</pre>}{error && <p role="alert">{error}</p>}{!done && <button className="assistant-btn assistant-btn-ghost" disabled={pending} onClick={() => void load()}>{uiText(pending ? 'assistant.activity.loading' : 'assistant.activity.more')}</button>}</div>
}
export function ToolActivityRow({ step, steps, chatId, expandAll, onStop, ancestors = [] }: { step: ActivityStep; steps: ActivityStep[]; chatId: string; expandAll: boolean; onStop(): void; ancestors?: string[] }): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
  const running = step.state === 'running' || step.state === 'approval'
  const open = expandAll || expanded
  const { Icon } = toolPresentation(step.name, step.arguments, running)
  return <details className="assistant-activity" open={open} onToggle={event => {
    if (expandAll) { if (!event.currentTarget.open) event.currentTarget.open = true }
    else setExpanded(event.currentTarget.open)
  }}>
    <summary title={uiText(`assistant.activity.${step.state}`)}>{step.state === 'failed' ? <Warning /> : <Icon />}<ActivityLabel name={step.name} args={step.arguments} running={running} />{step.state === 'failed' || step.state === 'approval' ? <span className="assistant-activity-meta">{uiText(`assistant.activity.${step.state}`)}</span> : null}<ChevronRight className="assistant-activity-caret" /></summary>
    <div className="assistant-activity-body">
      <pre className="assistant-activity-args">{JSON.stringify(step.arguments, null, 2)}</pre>
      {open && step.argumentsRef && <Output key={step.argumentsRef} chatId={chatId} reference={step.argumentsRef} revision={step.timestamp} />}
      {running && <button className="assistant-btn assistant-btn-ghost" onClick={onStop}>{uiText('assistant.activity.stop')}</button>}
      {open && step.outputRef && <Output key={step.outputRef} chatId={chatId} reference={step.outputRef} revision={step.timestamp} />}
      {open && step.diffRef && <Output key={step.diffRef} chatId={chatId} reference={step.diffRef} revision={step.timestamp} />}
      {open && step.resultRef && <Output key={step.resultRef} chatId={chatId} reference={step.resultRef} revision={step.timestamp} />}
      {step.result !== undefined && <pre className="assistant-activity-output">{JSON.stringify(step.result, null, 2)}</pre>}
      {steps.filter(child => child.runId === step.runId && child.parentCallId === step.callId && child.callId !== step.callId && !ancestors.includes(child.callId)).map(child => <ToolActivityRow key={key(child)} step={child} steps={steps} chatId={chatId} expandAll={expandAll} onStop={onStop} ancestors={[...ancestors, step.callId]} />)}
    </div>
  </details>
}
