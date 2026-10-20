import type { FC } from 'react'
import { React, api } from './runtime'
import { LuBot, LuWind, LuFlaskConical, LuChevronLeft, LuChevronRight, LuFolderOpen, LuPlay, LuPlus, LuRefreshCw, LuSquare } from './settingsIcons'
import type { FileBaseline, GuardedWriteResult } from '@valley/plugin-sdk/types'
import type { AiConnectionStatus } from './types'
import type {
  HarnessConfig,
  HarnessCreatePackage,
  HarnessEvent,
  HarnessManifest,
  HarnessPackageSnapshot,
  HarnessPackageStatus,
  HarnessRun,
  HarnessSettingField,
  HarnessSettingValue,
  HarnessTarget
} from './harnessTypes'
import { ASSISTANT_HARNESS_DIR, ASSISTANT_HARNESS_RUNS_DIR, ASSISTANT_HARNESS_SETTINGS_FILE } from './backend/harness/paths'
const CodeEditor: typeof api.ui.CodeEditor = (props) => React.createElement(api.ui.CodeEditor, props)
const iconForName = (name: string) => name === 'smart_toy' ? <LuBot /> : name === 'air' ? <LuWind /> : <LuFlaskConical />
const Button: typeof api.ui.settings.Button = (props) => React.createElement(api.ui.settings.Button, props)
const NumberField: typeof api.ui.settings.NumberField = props => <div className="settings-row-control assistant-native-field">{React.createElement(api.ui.settings.NumberField, props)}</div>
const Row: typeof api.ui.settings.Row = (props) => React.createElement(api.ui.settings.Row, props)
const SelectField: typeof api.ui.settings.SelectField = props => <div className="settings-row-control assistant-native-field">{React.createElement(api.ui.settings.SelectField, props)}</div>
const TextArea: typeof api.ui.settings.TextArea = (props) => React.createElement(api.ui.settings.TextArea, props)
const TextField: typeof api.ui.settings.TextField = (props) => React.createElement(api.ui.settings.TextField, props)
const Toggle: typeof api.ui.settings.Toggle = (props) => React.createElement(api.ui.settings.Toggle, props)
import css from './HarnessSettings.css'
let styles = false
function installStyles(): void { if (styles) return; styles = true; const element = document.createElement('style'); element.textContent = css; document.head.appendChild(element) }
import { uiText } from './localization'
import { words, Section, Status } from './Preferences'

interface AiResult<T> { ok: boolean; error?: string; data?: T }

async function invoke<T>(method: string, payload: unknown = {}): Promise<AiResult<T>> {
  try { return { ok: true, data: await api.backend.call<T>(`ai.${method}`, payload) } }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
}

type View = { kind: 'list' } | { kind: 'create' } | { kind: 'detail'; id: string }

export const AiHarnessesSection: FC = () => {
  installStyles()
  const [harnesses, setHarnesses] = React.useState<HarnessPackageStatus[] | null>(null)
  const [view, setView] = React.useState<View>({ kind: 'list' })
  const [error, setError] = React.useState('')

  const refresh = React.useCallback(async () => {
    const result = await invoke<{ harnesses: HarnessPackageStatus[] }>('listHarnesses')
    setHarnesses(result.data?.harnesses ?? [])
    setError(result.ok ? '' : result.error ?? uiText('auto.f4c0fd7be105'))
  }, [])

  React.useEffect(() => { void refresh() }, [refresh])

  if (view.kind === 'create') {
    return <CreateHarness onBack={() => setView({ kind: 'list' })} onCreated={async (id) => { await refresh(); setView({ kind: 'detail', id }) }} />
  }
  if (view.kind === 'detail') {
    const harness = harnesses?.find((item) => item.id === view.id)
    if (harness) return <HarnessDetail status={harness} onBack={() => setView({ kind: 'list' })} onChanged={refresh} />
  }

  return (
    <section className="settings-section settings-listpage harness-section">
      <div className="settings-listpage-header">
        <h4 className="settings-label">{uiText('assistant.settings.evaluationPackages')}</h4>
        <Button className="settings-listpage-add" size="small" aria-label={uiText('auto.e728e2a7cc8b')} title={uiText('auto.e728e2a7cc8b')} onClick={() => setView({ kind: 'create' })}>
          <LuPlus />
        </Button>
      </div>
      <p className="settings-description">{words('evaluationsHelp')}</p>
      {error && <div className="harness-error" role="alert">{error}</div>}
      {harnesses === null ? <div className="harness-empty">{uiText('auto.33ce417454bf')}</div> : (
        <div className="settings-list">
          {harnesses.map((harness) => (
            <button key={harness.id} type="button" className="settings-list-row" onClick={() => setView({ kind: 'detail', id: harness.id })}>
              <span className="settings-list-glyph">{iconForName(harness.icon)}</span>
              <span className="settings-list-meta">
                <span className="settings-list-name">{harness.name}</span>
                <span className="settings-list-sub">{harness.caseCount ?? 0} {uiText('auto.9bc5a758c161')}{harness.version}</span>
              </span>
              <span className={`harness-badge ${harness.ready ? 'ok' : 'off'}`}>{harness.ready ? uiText('auto.20c7c5522fc2') : harness.enabled ? uiText('auto.7f2f6a15cf8d') : uiText('auto.f4f4473df8cb')}</span>
              <LuChevronRight className="settings-list-chevron" />
            </button>
          ))}
          {harnesses.length === 0 && <div className="harness-empty">{uiText('auto.69301616a386')}</div>}
        </div>
      )}
    </section>
  )
}

const DetailHeader: FC<{ title: string; onBack: () => void }> = ({ title, onBack }) => (
  <div className="settings-listpage-crumbs">
    <button type="button" className="settings-listpage-back" aria-label={uiText('auto.1afb61c487b8')} onClick={onBack}><LuChevronLeft /></button>
    <span className="settings-crumb settings-crumb-current">{title}</span>
  </div>
)

const CreateHarness: FC<{ onBack: () => void; onCreated: (id: string) => Promise<void> }> = ({ onBack, onCreated }) => {
  const [id, setId] = React.useState('')
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [error, setError] = React.useState('')
  const create = async (): Promise<void> => {
    const cleanId = id.trim().toLowerCase()
    const manifest: HarnessManifest = { apiVersion: 1, id: cleanId, name: name.trim(), version: '0.1.0', description: description.trim(), enabled: true }
    const config: HarnessConfig = {
      packageKind: 'ai-harness', main: 'src/harness.ts', icon: 'flask-conical', settingsSchema: [],
      execution: { timeoutMs: 30000, memoryMb: 64, maxResponseBytes: 524288, maxTurns: 8, maxConcurrency: 3 },
      retry: { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 10000 },
      cache: { maxAgeDays: 14, maxSizeMb: 128 }
    }
    const starter = `import type { HarnessRegisterApi } from '@assistant/harness-sdk'\n\nexport function register(api: HarnessRegisterApi) {\n  return {\n    id: ${JSON.stringify(cleanId)},\n    cases: [api.case({\n      id: 'first-case',\n      name: 'First case',\n      async run({ complete }) {\n        const response = await complete({ messages: [{ role: 'user', content: 'Reply with: ready' }] })\n        const passed = response.text.toLowerCase().includes('ready')\n        return { status: passed ? 'pass' : 'fail', score: passed ? 1 : 0, assertions: [{ name: 'model is ready', passed }], metrics: {} }\n      }\n    })]\n  }\n}\n`
    const input: HarnessCreatePackage = { manifest, config, files: { 'src/harness.ts': starter } }
    const result = await invoke<{ harnesses: HarnessPackageStatus[] }>('createHarness', { package: input })
    if (!result.ok) setError(result.error ?? uiText('auto.91491eda2d60'))
    else await onCreated(cleanId)
  }
  return (
    <section className="settings-section settings-listpage harness-section">
      <DetailHeader title={uiText('auto.cf6840db45fd')} onBack={onBack} />
      {error && <div className="harness-error">{error}</div>}
      <Row title={uiText('auto.7db68055a788')} description={uiText('auto.0870f128b785')}><TextField ariaLabel={uiText('auto.7db68055a788')} value={id} onChange={setId} /></Row>
      <Row title={uiText('auto.709a23220f2c')}><TextField ariaLabel={uiText('auto.165f4ed3b626')} value={name} onChange={setName} /></Row>
      <Row title={uiText('auto.55f8ebc805e6')}><TextArea ariaLabel={uiText('auto.ca518bacf13c')} value={description} onChange={setDescription} /></Row>
      <div className="harness-actions"><Button onClick={() => void create()} disabled={!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || !name.trim()}>{uiText('auto.6e157c5da441')}</Button></div>
    </section>
  )
}

const SettingField: FC<{ field: HarnessSettingField; value: HarnessSettingValue | undefined; onChange: (value: HarnessSettingValue) => void }> = ({ field, value, onChange }) => {
  if (field.type === 'boolean') return <Toggle checked={Boolean(value)} onChange={onChange} />
  if (field.type === 'number' || field.type === 'range') return <NumberField ariaLabel={field.label} value={Number(value ?? 0)} min={field.min} max={field.max} step={field.step} onChange={(next) => onChange(next ?? 0)} />
  if (field.type === 'select') return <SelectField ariaLabel={field.label} value={String(value ?? '')} options={(field.options ?? []).map((option) => ({ value: option.value, label: option.label }))} onChange={onChange} />
  if (field.type === 'textarea') return <TextArea ariaLabel={field.label} value={String(value ?? '')} onChange={onChange} />
  return <TextField ariaLabel={field.label} value={String(value ?? '')} onChange={onChange} />
}

const HarnessDetail: FC<{ status: HarnessPackageStatus; onBack: () => void; onChanged: () => Promise<void> }> = ({ status, onBack, onChanged }) => {
  const [snapshot, setSnapshot] = React.useState<(HarnessPackageSnapshot & { readOnly?: boolean }) | null>(null)
  const [selectedFile, setSelectedFile] = React.useState('')
  const [source, setSource] = React.useState('')
  const [baseline, setBaseline] = React.useState<FileBaseline | null>(null)
  const [settings, setSettings] = React.useState<Record<string, HarnessSettingValue>>(status.settings)
  const [connections, setConnections] = React.useState<AiConnectionStatus[]>([])
  const [targets, setTargets] = React.useState<Set<string>>(new Set())
  const [useCache, setUseCache] = React.useState(false)
  const [concurrency, setConcurrency] = React.useState(Math.min(3, status.execution.maxConcurrency))
  const [activeRun, setActiveRun] = React.useState<HarnessRun | null>(null)
  const [progress, setProgress] = React.useState('')
  const [runs, setRuns] = React.useState<HarnessRun[]>([])
  const [note, setNote] = React.useState(''), [pending, setPending] = React.useState(false)
  const operation = async (work: () => Promise<void>) => { if (pending) return; setPending(true); try { await work() } catch (error) { setNote(String(error)) } finally { setPending(false) } }

  const refreshPackage = React.useCallback(async () => {
    const [packageResult, connectionResult, runResult] = await Promise.all([
      invoke<{ package: (HarnessPackageSnapshot & { readOnly?: boolean }) | null }>('readHarnessPackage', { id: status.id }),
      invoke<{ connections: AiConnectionStatus[] }>('listConnections'),
      invoke<{ runs: HarnessRun[] }>('listHarnessRuns', { id: status.id, limit: 50 })
    ])
    const failure = [packageResult, connectionResult, runResult].find(result => !result.ok)
    if (failure) setNote(failure.error ?? words('unavailable'))
    const next = packageResult.data?.package ?? null
    setSnapshot(next)
    setConnections(connectionResult.data?.connections ?? [])
    setRuns(runResult.data?.runs ?? [])
    if (next && !selectedFile) {
      const file = next.files.find((item) => item.path === next.config.main) ?? next.files[0]
      if (file) { setSelectedFile(file.path); setSource(file.content); setBaseline(file.baseline) }
    }
  }, [selectedFile, status.id])

  React.useEffect(() => { void refreshPackage() }, [refreshPackage])
  React.useEffect(() => api.backend.on('harness', (event) => {
    const harnessEvent = event as HarnessEvent
    if (harnessEvent.harnessId !== status.id) return
    if (harnessEvent.run) setActiveRun(harnessEvent.run)
    if (harnessEvent.type === 'case-started') setProgress(uiText('harness.running', { case: harnessEvent.caseId ?? '', model: harnessEvent.target?.model ?? '' }))
    else if (harnessEvent.type === 'retry') setProgress(uiText('harness.retry', { attempt: harnessEvent.attempt ?? '', case: harnessEvent.caseId ?? '', delay: harnessEvent.delayMs ?? 0 }))
    else if (harnessEvent.type === 'case-completed') setProgress(uiText('harness.completed', { case: harnessEvent.caseId ?? '', model: harnessEvent.target?.model ?? '' }))
    else if (['completed', 'cancelled', 'error'].includes(harnessEvent.type)) setProgress(harnessEvent.type)
    if (['completed', 'cancelled', 'error'].includes(harnessEvent.type)) void refreshPackage()
  }), [refreshPackage, status.id])

  const modelTargets = React.useMemo(() => connections.flatMap((connection) => connection.models.map((model) => ({
    key: `${connection.id}:${model.id}`,
    label: `${connection.label || connection.providerName} · ${model.label || model.id}`,
    target: { provider: connection.provider, connectionId: connection.id, model: model.id } satisfies HarnessTarget
  }))), [connections])

  const chooseFile = (path: string): void => {
    if (source !== snapshot?.files.find(item => item.path === selectedFile)?.content) { setNote(words('unsavedSource')); return }
    const file = snapshot?.files.find((item) => item.path === path)
    if (!file) return
    setSelectedFile(path); setSource(file.content); setBaseline(file.baseline); setNote('')
  }
  const saveSource = async (): Promise<void> => {
    const result = await api.backend.call('ai.writeHarnessFile', { id: status.id, path: selectedFile, content: source, baseline }) as GuardedWriteResult
    if (!result.ok) setNote(result.reason === 'conflict' ? uiText('auto.d22b75501c76') : uiText('auto.aefc6368e519'))
    else { setBaseline(result.baseline); setSnapshot(current => current ? { ...current, files: current.files.map(file => file.path === selectedFile ? { ...file, content: source, baseline: result.baseline } : file) } : current); setNote(uiText('auto.c25cd72b36ba')) }
  }
  const saveSettings = async (): Promise<void> => {
    const result = await invoke('saveHarnessSettings', { id: status.id, values: settings })
    setNote(result.ok ? uiText('auto.f133b2924e9e') : result.error ?? uiText('auto.b14461cb7a0d'))
    if (result.ok) await onChanged()
  }
  const setEnabled = async (enabled: boolean): Promise<void> => {
    const manifestFile = snapshot?.files.find((item) => item.path === 'manifest.json')
    if (!snapshot || !manifestFile) return
    const result = await api.backend.call('ai.updateHarnessManifest', {
      id: status.id,
      manifest: { ...snapshot.manifest, enabled },
      baseline: manifestFile.baseline
    }) as GuardedWriteResult
    if (!result.ok) setNote(result.reason === 'conflict' ? uiText('auto.f6f16e6bcc92') : uiText('auto.0bfeef746849'))
    else { await reload() }
  }
  const reload = async (): Promise<void> => {
    if (source !== snapshot?.files.find(item => item.path === selectedFile)?.content) { setNote(words('unsavedSource')); return }
    const result = await invoke('reloadHarnesses')
    setNote(result.ok ? uiText('auto.aea3a8f18cf7') : result.error ?? uiText('auto.834e20964f49'))
    await onChanged(); await refreshPackage()
  }
  const run = async (): Promise<void> => {
    const selected = modelTargets.filter((item) => targets.has(item.key)).map((item) => item.target)
    setProgress(uiText('harness.starting'))
    const result = await invoke<{ run: HarnessRun | null }>('runHarness', { id: status.id, targets: selected, options: { useCache, concurrency } })
    if (result.data?.run) setActiveRun(result.data.run)
    else setNote(result.error ?? uiText('auto.d2c500ad386d'))
  }
  const cancel = async (): Promise<void> => {
    if (activeRun) await invoke('cancelHarnessRun', { runId: activeRun.id })
  }

  const finishedRuns = runs.filter((item) => item.status === 'completed')
  return (
    <section className="settings-section settings-listpage harness-section">
      <DetailHeader title={status.name} onBack={() => { if (pending) return; if (selectedFile && source !== snapshot?.files.find(file => file.path === selectedFile)?.content) { setNote(words('unsavedSource')); return } onBack() }} />
      <div className="harness-identity">
        <span className="settings-list-glyph settings-list-glyph--lg">{iconForName(status.icon)}</span>
        <span className="settings-list-meta"><strong>{status.name}</strong><span className="settings-list-sub">{status.id} {uiText('auto.26c12f1ee6e3')}{status.version} · {status.ready ? uiText('auto.20c7c5522fc2') : uiText('auto.2b50ff807d04')}</span></span>
      </div>
      <div className="harness-note">{uiText('harness.manualFiles', { settings: ASSISTANT_HARNESS_SETTINGS_FILE, runs: ASSISTANT_HARNESS_RUNS_DIR })}</div>
      {status.updateAvailable && <div className="harness-warning">{uiText('auto.7da78a24b105')}</div>}
      {status.error && <div className="harness-error">{status.error}</div>}
      <Status pending={pending} />
      <Section title={words('packageSettings')}>
      <Row title={uiText('auto.df174a3f2faa')} description={uiText('auto.ec61b1e4d048')}><Toggle checked={status.enabled} disabled={pending} onChange={(value) => void operation(() => setEnabled(value))} /></Row>
      {status.settingsSchema.map((field) => (
        <Row key={field.key} title={field.label} description={field.description}>
          <SettingField field={field} value={settings[field.key]} onChange={(value) => setSettings((current) => ({ ...current, [field.key]: value }))} />
        </Row>
      ))}
      {status.settingsSchema.length > 0 && <div className="harness-actions"><Button onClick={() => void operation(saveSettings)}>{uiText('auto.33e5a54638ad')}</Button></div>}

      </Section>
      <div className="harness-toolbar">
        <strong>{uiText('auto.d403d5220e8b')}</strong>
        <span />
        <Button disabled={snapshot?.readOnly} size="small" onClick={() => void api.files.revealInFinder(`${ASSISTANT_HARNESS_DIR}/${status.id}`)}><LuFolderOpen /> {uiText('auto.90c0c2eb98de')}</Button>
        <Button size="small" onClick={() => void operation(reload)}><LuRefreshCw /> {uiText('auto.cce7155371fc')}</Button>
      </div>
      <div className="harness-editor-grid">
        <div className="harness-files">{snapshot?.files.map((file) => <button key={file.path} type="button" className={file.path === selectedFile ? 'active' : ''} onClick={() => chooseFile(file.path)}>{file.path}</button>)}</div>
        <CodeEditor readOnly={snapshot?.readOnly} value={source} onChange={setSource} ariaLabel={uiText('auto.5db86a3a809e', { p0: selectedFile })} className="harness-code-editor" />
      </div>
      {snapshot?.readOnly && <div className="harness-note">{uiText('harness.packageSource')}</div>}
      <div className="harness-actions"><Button onClick={() => void operation(saveSource)} disabled={pending || !selectedFile || snapshot?.readOnly}>{uiText('auto.c7e618e01d9b')}</Button></div>

      <div className="harness-run-panel">
        <strong>{uiText('auto.6e808259a43d')}</strong>
        <div className="harness-targets">{modelTargets.map((item) => <Row key={item.key} title={item.label}><Toggle label={item.label} checked={targets.has(item.key)} onChange={checked => setTargets(current => { const next = new Set(current); if (checked) next.add(item.key); else next.delete(item.key); return next })} /></Row>)}</div>
        <Row title={uiText('auto.592929d9a35c')} description={uiText('auto.74fca4a23de7')}><Toggle checked={useCache} onChange={setUseCache} /></Row>
        <Row title={uiText('auto.4d781e68856b')} description={uiText('auto.18db257e2f7f', { p0: status.execution.maxConcurrency })}><NumberField ariaLabel={uiText('auto.4d781e68856b')} value={concurrency} min={1} max={status.execution.maxConcurrency} step={1} onChange={(value) => setConcurrency(value ?? 1)} /></Row>
        <div className="harness-actions">
          {activeRun?.status === 'running' ? <Button onClick={() => void operation(cancel)}><LuSquare /> {uiText('auto.77dfd2135f4d')}</Button> : <Button onClick={() => void operation(run)} disabled={pending || targets.size === 0 || !status.ready}><LuPlay /> {uiText('auto.b1b392607dea')}</Button>}
          {activeRun && <span>{uiText(`harness.status.${activeRun.status}`)} · {activeRun.targets.length} {uiText('auto.24313f3d81a4')}</span>}
        </div>
        {progress && <div className="harness-note" aria-live="polite">{progress}</div>}
      </div>
      {note && <div className="harness-note">{note}</div>}

      <div className="harness-history">
        <strong>{uiText('auto.90ccd6497400')}</strong>
        <div className="harness-score-graph" aria-label={uiText('auto.4a000615a553')}>{finishedRuns.slice(0, 20).reverse().map((item) => {
          const score = item.targets.length ? item.targets.reduce((sum, target) => sum + target.score, 0) / item.targets.length : 0
          return <span key={item.id} title={`${new Date(item.startedAt).toLocaleString()}: ${(score * 100).toFixed(0)}%`} style={{ height: `${Math.max(3, score * 100)}%` }} />
        })}</div>
        {runs.slice(0, 10).map((item) => <details key={item.id}><summary>{new Date(item.startedAt).toLocaleString()} · {uiText(`harness.status.${item.status}`)} · {item.options.useCache ? uiText('auto.2e9a6087d7a3') : uiText('auto.fca812722101')}</summary>{item.targets.map((target) => <div key={`${target.target.connectionId}:${target.target.model}`} className="harness-result"><strong>{target.target.model}: {(target.score * 100).toFixed(0)}%</strong>{target.cases.map((caseRun) => <div key={caseRun.id}>{caseRun.name}: {uiText(`harness.status.${caseRun.status}`)} ({(caseRun.score * 100).toFixed(0)}%) · {caseRun.hostMetrics.latencyMs} {uiText('auto.8b490c5d3676')}{caseRun.hostMetrics.cacheHits} {uiText('auto.0c93713c1e43')}<details><summary>{uiText('auto.ddf6a1f0ce8c')}</summary><pre>{JSON.stringify({ ...caseRun.metrics, ...caseRun.hostMetrics }, null, 2)}</pre></details></div>)}</div>)}</details>)}
      </div>
    </section>
  )
}
