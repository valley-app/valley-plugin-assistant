import { React, api } from './runtime'
import { uiText } from './localization'
import { flattenModels } from './models'
import { FolderOpen, Plus, Trash, X } from './icons'
import type { AiConnectionStatus, AiPersonality } from './types'
import type { MarkdownSettings } from './backend/configuration/settings'
import type { SpeechSettings } from './backend/configuration/schemas'
import type { SpeechVoice } from '@valley/plugin-sdk/speech'

export const words = (key: string) => uiText(`assistant.preferences.${key}`)
export const Row: typeof api.ui.settings.Row = props => React.createElement(api.ui.settings.Row, props)
export const Button: typeof api.ui.settings.Button = props => React.createElement(api.ui.settings.Button, props)
export const Select: typeof api.ui.settings.SelectField = props => <div className="settings-row-control assistant-native-field">{React.createElement(api.ui.settings.SelectField, props)}</div>
export const Toggle: typeof api.ui.settings.Toggle = props => React.createElement(api.ui.settings.Toggle, props)
export const Section = ({ title, children }: { title: string; children: React.ReactNode }) => <section className="assistant-preference-section"><h4 className="settings-label">{title}</h4>{children}</section>
export const Status = ({ loading, pending, error }: { loading?: boolean; pending?: boolean; error?: string }) => <>{(loading || pending) && <p className="settings-description" role="status">{words(loading ? 'loading' : 'saving')}</p>}{error && <p className="assistant-set-err" role="alert">{error}</p>}</>

export function useSettingsResource<T>(read: () => Promise<T>) {
  const [value, setValue] = React.useState<T>(), [error, setError] = React.useState(''), [pending, setPending] = React.useState(false)
  const generation = React.useRef(0), mounted = React.useRef(true), saving = React.useRef(false)
  const refresh = React.useCallback(async () => {
    const id = ++generation.current
    try { const next = await read(); if (mounted.current && id === generation.current) { setValue(next); setError('') } }
    catch (error) { if (mounted.current && id === generation.current) setError(String(error)) }
  }, [read])
  React.useEffect(() => {
    mounted.current = true
    void refresh()
    const off = api.backend.on('configuration.changed', () => { void refresh() })
    const offFiles = api.data.files.onChanged(path => { if (path.endsWith('.md')) void refresh() })
    const offVault = api.vault.onChanged(() => { setValue(undefined); void refresh() })
    return () => { mounted.current = false; generation.current++; off(); offFiles(); offVault() }
  }, [refresh])
  const save = async (work: () => Promise<unknown>) => {
    if (saving.current) return false
    saving.current = true; setPending(true)
    try { await work(); await refresh(); return true }
    catch (error) { if (mounted.current) setError(String(error)); return false }
    finally { saving.current = false; if (mounted.current) setPending(false) }
  }
  return { value, error, pending, refresh, save }
}

export function SavedText({ value, label, disabled, onSave, type = 'text' }: { value: string; label: string; disabled?: boolean; onSave(value: string): Promise<unknown>; type?: 'text' | 'password' }) {
  const [draft, setDraft] = React.useState(value), [dirty, setDirty] = React.useState(false)
  const committing = React.useRef(false)
  React.useEffect(() => { if (!dirty) setDraft(value) }, [value, dirty])
  const commit = async () => {
    if (!dirty || disabled || committing.current) return
    committing.current = true
    try { if (await onSave(draft) !== false) setDirty(false) } finally { committing.current = false }
  }
  return <div className="settings-row-control assistant-preference-control"><api.ui.settings.TextField ariaLabel={label} value={draft} type={type} disabled={disabled} onChange={next => { setDraft(next); setDirty(next !== value) }} onCommit={() => { void commit() }} /><Button size="small" disabled={disabled || !dirty} onClick={() => void commit()}>{uiText('auto.efc007a393f6')}</Button></div>
}

export function useChoices() {
  const read = React.useCallback(async () => {
    const [models, profiles] = await Promise.all([api.assistant.listConnections(), api.assistant.listPersonalities()])
    if (!models.ok || !profiles.ok) throw new Error(models.error || profiles.error)
    return { connections: models.data?.connections ?? [], profiles: profiles.data?.personalities ?? [] }
  }, [])
  return useSettingsResource(read)
}
export function modelOptions(connections: AiConnectionStatus[], value: string) {
  const options = [{ value: '', label: words('inherit') }, ...flattenModels(connections)]
  if (value && !options.some(option => option.value === value)) options.push({ value, label: `${value} · ${words('unavailable')}` })
  return options
}
export function profileOptions(profiles: AiPersonality[], value: string) {
  const options = [{ value: '', label: words('inherit') }, ...profiles.map(profile => ({ value: profile.id, label: profile.name }))]
  if (value && !options.some(option => option.value === value)) options.push({ value, label: `${value} · ${words('unavailable')}` })
  return options
}

export function ChatPreferences() {
  const read = React.useCallback(() => api.backend.call<MarkdownSettings>('configuration.settings'), [])
  const state = useSettingsResource(read), choices = useChoices(), settings = state.value
  const save = (key: string, value: unknown) => state.save(async () => { const result = await api.settings.set(key, value); if (result && !result.ok) throw new Error(words('unavailable')) })
  const select = (key: keyof MarkdownSettings, options: { value: string; label: string }[]) => <Row title={words(key)}><Select ariaLabel={words(key)} value={String(settings?.[key] ?? '')} options={options} disabled={state.pending} onChange={value => { void save(key, value) }} /></Row>
  const toggle = (key: keyof MarkdownSettings) => <Row key={key} title={words(key)}><Toggle label={words(key)} checked={settings?.[key] === true} disabled={state.pending} onChange={value => { void save(key, value) }} /></Row>
  return <><Status loading={!settings && !state.error} pending={state.pending} error={state.error || choices.error} />{settings && <>
    <Section title={words('newChats')}><p className="settings-description">{words('runtime')}</p>
      {select('defaultModel', modelOptions(choices.value?.connections ?? [], settings.defaultModel))}
      {select('defaultProfileId', profileOptions(choices.value?.profiles ?? [], settings.defaultProfileId))}
      {toggle('automaticChatNaming')}
    </Section>
    <Section title={words('appearance')}>
      <Row title={words('sendOnEnter')}><Select ariaLabel={words('sendOnEnter')} value={settings.sendOnEnter ? 'enter' : 'mod'} options={[{ value: 'enter', label: 'Enter' }, { value: 'mod', label: '⌘ / Ctrl + Enter' }]} disabled={state.pending} onChange={value => { void save('sendOnEnter', value === 'enter') }} /></Row>
      {toggle('showTimestamps')}{toggle('showTelegram')}{toggle('showWhatsApp')}
      {select('commandReporting', ['context', 'descriptive', 'concise'].map(value => ({ value, label: words(value) })))}
    </Section>
    <Section title={words('attachments')}>
      {select('attachmentParser', [{ value: 'markitdown', label: 'MarkItDown' }, ...modelOptions(choices.value?.connections ?? [], settings.attachmentParser).filter(option => option.value && option.value !== 'markitdown')])}
      <Row title={words('attachmentFolder')} description={words('attachmentFolderHelp')}><SavedText label={words('attachmentFolder')} value={settings.attachmentFolder} disabled={state.pending} onSave={value => save('attachmentFolder', value.trim())} /></Row>
      <Row title={words('importMaxBytes')}><SavedText label={words('importMaxBytes')} value={String(settings.importMaxBytes / 1048576)} disabled={state.pending} onSave={value => save('importMaxBytes', Number(value) * 1048576)} /></Row>
    </Section>
    <Storage path=".valley/plugins/data/assistant/chats" />
  </>}</>
}

export const Storage = ({ path = '.valley/plugins/data/assistant' }: { path?: string }) => <Row title={words('storage')} description={path}><Button variant="ghost" onClick={() => api.files.revealInFinder(path)}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><FolderOpen />{words('openFolder')}</span></Button></Row>

export function SpeechPreferences() {
  const read = React.useCallback(() => api.backend.call<SpeechSettings>('configuration.speech'), [])
  const state = useSettingsResource(read), value = state.value
  const [voices, setVoices] = React.useState<SpeechVoice[]>([]), [voiceError, setVoiceError] = React.useState(''), [loadingVoices, setLoadingVoices] = React.useState(false)
  const save = (patch: Partial<SpeechSettings>) => state.save(() => api.backend.call('configuration.speech.set', patch))
  React.useEffect(() => { setVoices([]); setVoiceError('') }, [value?.provider, value?.connectionId])
  const loadVoices = async () => {
    if (!value || loadingVoices) return
    setLoadingVoices(true); setVoiceError('')
    try { setVoices(await api.ai.speech.voices({ provider: value.provider, connectionId: value.connectionId })) } catch (error) { setVoiceError(String(error)) } finally { setLoadingVoices(false) }
  }
  const providers = [{ value: 'elevenlabs', label: 'ElevenLabs' }, { value: 'openai', label: 'OpenAI' }]
  return <Section title={words('speech')}><Status loading={!value && !state.error} pending={state.pending} error={state.error || voiceError} />{value && <>
    <Row title={words('provider')}><Select ariaLabel={words('provider')} value={value.provider} disabled={state.pending} options={providers} onChange={provider => { void save({ provider: provider as SpeechSettings['provider'], connectionId: '', voiceId: '' }) }} /></Row>
    {(['connectionId', 'synthesisModel', 'transcriptionConnectionId', 'transcriptionModel', 'realtimeModel'] as const).map(key => <Row key={key} title={words(key)}><SavedText label={words(key)} value={value[key] ?? ''} disabled={state.pending} onSave={text => save({ [key]: text.trim() })} /></Row>)}
    <Row title={words('transcriptionProvider')}><Select ariaLabel={words('transcriptionProvider')} value={value.transcriptionProvider ?? value.provider} disabled={state.pending} options={providers} onChange={provider => { void save({ transcriptionProvider: provider as SpeechSettings['transcriptionProvider'] }) }} /></Row>
    <Row title={words('voice')}><div className="settings-row-control assistant-preference-control"><Select ariaLabel={words('voice')} disabled={state.pending} value={value.voiceId ?? ''} options={[{ value: '', label: words('chooseVoice') }, ...voices.map(voice => ({ value: voice.id, label: voice.name })), ...(value.voiceId && !voices.some(voice => voice.id === value.voiceId) ? [{ value: value.voiceId, label: value.voiceId }] : [])]} onChange={voiceId => { void save({ voiceId }) }} /><Button size="small" disabled={loadingVoices} onClick={() => void loadVoices()}>{words(loadingVoices ? 'loading' : 'loadVoices')}</Button></div></Row>
    <Row title={words('liveMode')}><Select ariaLabel={words('liveMode')} value={value.liveMode} disabled={state.pending} options={['push-to-talk', 'hands-free'].map(mode => ({ value: mode, label: words(mode) }))} onChange={liveMode => { void save({ liveMode: liveMode as SpeechSettings['liveMode'] }) }} /></Row>
    <Row title={words('fallbackProvider')}><Select ariaLabel={words('fallbackProvider')} value={value.fallbackProvider ?? ''} disabled={state.pending} options={[{ value: '', label: words('disabled') }, ...providers]} onChange={fallbackProvider => { void save({ fallbackProvider: (fallbackProvider || null) as SpeechSettings['fallbackProvider'] }) }} /></Row>
    <Row title={words('replyWithVoice')}><Toggle label={words('replyWithVoice')} checked={value.replyWithVoice} disabled={state.pending} onChange={replyWithVoice => { void save({ replyWithVoice }) }} /></Row>
    <Button variant="ghost" onClick={() => api.workspace.openFile('.valley/plugins/data/assistant/speech.md')}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><FolderOpen />{words('openNote')}</span></Button>
  </>}</Section>
}

export function Personalities() {
  const read = React.useCallback(async () => { const result = await api.assistant.listPersonalities(); if (!result.ok) throw new Error(result.error); return result.data?.personalities ?? [] }, [])
  const state = useSettingsResource(read), [name, setName] = React.useState(''), [removing, setRemoving] = React.useState<string>()
  const checked = async (work: Promise<{ ok: boolean; error?: string }>) => { const result = await work; if (!result.ok) throw new Error(result.error) }
  const rename = (profile: AiPersonality, name: string) => state.save(async () => { const current = await api.assistant.readPersonality(profile.id); if (!current.ok || !current.data?.personality) throw new Error(current.error || words('unavailable')); await checked(api.assistant.savePersonality({ ...current.data.personality, name: name.trim() })) })
  return <Section title={words('personalities')}><Status loading={!state.value && !state.error} pending={state.pending} error={state.error} />{state.value?.map(profile => <Row key={profile.id} title={profile.name}>
    <div className="assistant-preference-stack"><SavedText label={`${words('name')}: ${profile.name}`} value={profile.name} disabled={state.pending} onSave={name => name.trim() ? rename(profile, name) : Promise.resolve(false)} />
      <div className="settings-row-control assistant-preference-control"><Button variant="ghost" disabled={!profile.instructionsPath} onClick={() => { if (profile.instructionsPath) api.workspace.openFile(profile.instructionsPath) }}>{words('openNote')}</Button>
      {profile.id !== 'default' && (removing === profile.id ? <><Button variant="danger" disabled={state.pending} onClick={() => { void state.save(() => checked(api.assistant.deletePersonality(profile.id))).then(ok => { if (ok) setRemoving(undefined) }) }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Trash />{words('delete')}</span></Button><Button variant="ghost" onClick={() => setRemoving(undefined)}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><X />{words('cancel')}</span></Button></> : <Button variant="ghost" onClick={() => setRemoving(profile.id)}><Trash /></Button>)}</div>
    </div></Row>)}
    <Row title={words('newPersonality')}><div className="settings-row-control assistant-preference-control"><api.ui.settings.TextField ariaLabel={words('newPersonality')} value={name} onChange={setName} /><Button disabled={state.pending || !name.trim()} onClick={() => { void state.save(async () => {
      const config = await api.assistant.getConfig(); if (!config.ok || !config.data) throw new Error(config.error)
      await checked(api.assistant.savePersonality({ id: `profile-${crypto.randomUUID()}`, name: name.trim(), isDefault: false, instructions: '', routing: config.data.routing }))
      setName('')
    }) }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus />{words('add')}</span></Button></div></Row>
  </Section>
}
