import { projectSelection, type ProjectContext } from './ProjectMode'
import { AiHarnessesSection } from './HarnessSettings'
import { React, api } from './runtime'
import type { FC, ReactNode } from 'react'
import type { AiChatSummary, AiChatThread, AiConnectionStatus, AiPersonality, AssistantProject, ChannelInfo } from './types'
import { useAssistant } from './hooks'
import { Chat, Folder, ChevronLeft, ChevronRight, Telegram, WhatsApp, Trash, X, Plus, FolderOpen } from './icons'
import { uiText } from './localization'
import { ChatPreferences, SpeechPreferences, Personalities, Storage, Section, Status, SavedText, Select, words, useChoices, modelOptions, profileOptions } from './Preferences'
import { modelValue, parseModelValue } from './models'
import { LuPlus } from './settingsIcons'
import { changeConversation, readConversation } from './commands'
import type { ConfigurationStatus } from './backend/configuration'

const SettingsRow: typeof api.ui.settings.Row = props => React.createElement(api.ui.settings.Row, props)
const Button: typeof api.ui.settings.Button = props => React.createElement(api.ui.settings.Button, props)
const TextField: typeof api.ui.settings.TextField = props => React.createElement(api.ui.settings.TextField, props)
const Toggle: typeof api.ui.settings.Toggle = props => React.createElement(api.ui.settings.Toggle, props)
const RowControl: FC<{ children: ReactNode }> = ({ children }) => <div className="settings-row-control">{children}</div>

const ListPage: FC<{ title: string; addLabel?: string; onAdd?: () => void; children: ReactNode }> = ({ title, addLabel, onAdd, children }) => <section className="settings-section settings-listpage">
  <div className="settings-listpage-header"><h4 className="settings-label">{title}</h4>{onAdd && <Button className="settings-listpage-add" size="small" aria-label={addLabel} title={addLabel} onClick={onAdd}><LuPlus /></Button>}</div>
  <div className="settings-list">{children}</div>
</section>
const ListRow: FC<{ glyph: ReactNode; name: string; sub: ReactNode; onOpen: () => void }> = ({ glyph, name, sub, onOpen }) => <div className="settings-list-row" role="button" tabIndex={0} onClick={onOpen} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() } }}>
  <span className="settings-list-glyph">{glyph}</span><span className="settings-list-meta"><span className="settings-list-name">{name}</span><span className="settings-list-sub">{sub}</span></span><ChevronRight className="settings-list-chevron" />
</div>
const CrumbBand: FC<{ backTo: string; current: string; onBack: () => void }> = ({ backTo, current, onBack }) => <div className="settings-listpage-crumbs">
  <button type="button" className="settings-listpage-back" aria-label={uiText('auto.b70b6ab0baad', { p0: backTo })} onClick={onBack}><ChevronLeft /></button><span className="settings-crumb settings-crumb-current">{current}</span>
</div>

export const ConfigurationLinks: FC<{ scope?: 'settings' | 'chat' | 'channel' | 'conversation' | 'project'; id?: string; compact?: boolean }> = ({ scope = 'settings', id, compact }) => {
  const [status, setStatus] = React.useState<ConfigurationStatus | null>(null)
  const [error, setError] = React.useState('')
  const [choosing, setChoosing] = React.useState<string | null>(null)
  const [choice, setChoice] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const request = React.useRef(0)
  const refresh = React.useCallback(async () => {
    const generation = ++request.current
    const value = await api.backend.call<ConfigurationStatus>('configuration.status', { scope, ...(id ? { id } : {}) })
    if (generation === request.current) { setStatus(value); setError('') }
  }, [scope, id])
  React.useEffect(() => {
    let live = true
    const update = () => { if (live) void refresh().catch(error => { if (live) setError(String(error)) }) }
    update()
    const offFiles = api.data.files.onChanged(path => { if (path.endsWith('.md')) update() })
    const off = api.backend.on('configuration.changed', update), offError = api.backend.on('configuration.error', update), offVault = api.vault.onChanged(update)
    return () => { live = false; request.current++; off(); offError(); offVault(); offFiles() }
  }, [refresh])
  const choose = async (): Promise<void> => {
    if (!choosing || !choice || saving) return
    setSaving(true)
    try { await api.backend.call('configuration.link', { key: choosing, path: choice }); setChoosing(null); await refresh() }
    catch (error) { setError(String(error)) } finally { setSaving(false) }
  }
  const Row = compact ? PropertyRow : SettingsRow
  return <>
    {!status && !error && <Status loading />}
    {!compact && <p className="settings-description">{words('notesHelp')}</p>}
    {error && <p role="alert" className="assistant-set-err">{error}</p>}
    {status?.diagnostics.map(diagnostic => <p key={diagnostic.path} role="alert" className="assistant-set-err">{diagnostic.message}{diagnostic.retained ? ` · ${uiText('assistant.configuration.retained')}` : ''}</p>)}
    {(['instructions', 'files'] as const).map(group => {
      const notes = status?.notes.filter(note => note.group === group) ?? []
      return notes.length ? <React.Fragment key={group}>{!compact && <h4 className="settings-label">{words(group)}</h4>}{notes.map(note => <Row key={note.id} title={uiText(`assistant.configuration.note.${note.id}`)} description={note.path}>
        <RowControl><Button variant="ghost" size="small" onClick={() => api.workspace.openFile(note.path)}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><FolderOpen />{uiText('auto.cf9b77061f7b')}</span></Button>{note.key && <Button variant="ghost" size="small" onClick={() => { setChoosing(note.key!); setChoice(note.path) }}>{uiText('assistant.configuration.choose')}</Button>}</RowControl>
      </Row>)}</React.Fragment> : null
    })}
    {choosing && <api.ui.Modal title={uiText('assistant.configuration.choose')} size="small" onClose={() => { if (!saving) setChoosing(null) }} footer={<Button disabled={saving || !choice} onClick={() => void choose()}>{uiText('auto.501e8582e34a')}</Button>}>
      <api.ui.ResourcePicker value={choice} onChange={value => setChoice(value)} kinds={['file']} filters={{ extension: 'md' }} allowCustom={false} ariaLabel={uiText('assistant.configuration.choose')} />
    </api.ui.Modal>}
  </>
}

const PropertyRow: typeof api.ui.settings.Row = ({ title, description, children }) => <div className="assistant-property-row"><div className="assistant-property-label" title={typeof description === 'string' ? description : undefined}>{title}</div><div className="assistant-property-control">{children}</div></div>

export const ChatDetail: FC<{ summary: AiChatSummary; personalities: AiPersonality[]; connections: AiConnectionStatus[]; backTo: string; onBack: () => void; onChanged: () => Promise<void>; embedded?: boolean }> = ({ summary, backTo, onBack, onChanged, embedded }) => {
  const { snap, store } = useAssistant(), Row = embedded ? PropertyRow : SettingsRow
  const [thread, setThread] = React.useState<AiChatThread | null>(null), [error, setError] = React.useState(''), [confirmDelete, setConfirmDelete] = React.useState(false)
  React.useEffect(() => { let live = true; void readConversation(api, summary.id).then(value => { if (live) setThread(value) }).catch(error => { if (live) setError(String(error)) }); return () => { live = false } }, [summary.id])
  const action = async (run: () => Promise<unknown>) => { try { await run(); await onChanged(); setError('') } catch (error) { setError(String(error)) } }
  return <>
    {!embedded && <CrumbBand backTo={backTo} current={summary.title} onBack={onBack} />}
    {error && <p role="alert">{error}</p>}
    {thread && <>
      <Row title={uiText('assistant.permissions.heading')}><api.ui.settings.SelectField value={snap.dangerous?.enabled ? 'full' : 'vault'} ariaLabel={uiText('assistant.permissions.heading')} options={[{ value: 'vault', label: uiText('assistant.permissions.vault') }, { value: 'full', label: uiText('assistant.permissions.full') }]} onChange={value => { void action(() => store.setAccessMode(value === 'full' ? 'full' : 'vault')) }} /></Row>
      <Row title={uiText('assistant.surface.title')}><TextField value={thread.title} ariaLabel={uiText('assistant.surface.title')} onChange={title => setThread({ ...thread, title })} onCommit={title => { void action(async () => { const result = await api.assistant.renameChat(thread.id, title); if (!result.ok) throw new Error(result.error) }) }} /></Row>
      <Row title={uiText('assistant.surface.pinned')}><Toggle checked={thread.pinned === true} label={uiText('assistant.surface.pinned')} onChange={pinned => { setThread({ ...thread, pinned }); void action(async () => { const result = await api.assistant.setChatPinned(thread.id, pinned); if (!result.ok) throw new Error(result.error) }) }} /></Row>
      <ConfigurationLinks scope="conversation" id={thread.id} compact={embedded} />
      <Row title=""><RowControl>{confirmDelete ? <><Button variant="danger" onClick={() => { void action(async () => { await changeConversation(api, thread.id, 'delete-chat'); onBack() }) }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Trash />{uiText('auto.c9f2829e382c')}</span></Button><Button variant="ghost" onClick={() => setConfirmDelete(false)}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><X />{uiText('auto.77dfd2135f4d')}</span></Button></> : <Button variant="ghost" onClick={() => setConfirmDelete(true)}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Trash />{uiText('auto.db9121e79c1c')}</span></Button>}</RowControl></Row>
    </>}
  </>
}

export const ProjectsPane: FC = () => {
  const selected = React.useSyncExternalStore(projectSelection.subscribe, projectSelection.getSnapshot)
  const [projects, setProjects] = React.useState<AssistantProject[]>([]), [context, setContext] = React.useState<ProjectContext | null>(null)
  const [pending, setPending] = React.useState(false), [error, setError] = React.useState(''), [deleting, setDeleting] = React.useState(false), [loaded, setLoaded] = React.useState(false)
  const request = <T,>(method: string, payload?: unknown) => api.backend.call<T>('projects.request', { method, payload })
  const refresh = React.useCallback(async () => { setProjects(await api.backend.call<AssistantProject[]>('projects.request', { method: 'list' })); setLoaded(true) }, [])
  React.useEffect(() => { void refresh().catch(error => setError(String(error))); return api.backend.on('projects.changed', () => { void refresh().catch(error => setError(String(error))) }) }, [refresh])
  React.useEffect(() => {
    let live = true
    setContext(null); setDeleting(false)
    const update = () => { if (selected) void request<ProjectContext>('context', { id: selected }).then(value => { if (live) setContext(value) }).catch(error => { if (live) setError(String(error)) }) }
    update()
    const off = api.data.files.onChanged(path => { if (path.endsWith('.md')) { update(); void refresh().catch(error => { if (live) setError(String(error)) }) } })
    return () => { live = false; off() }
  }, [selected, refresh])
  const perform = async (method: string, patch: Record<string, unknown> = {}) => {
    setPending(true)
    try { const value = await request<ProjectContext>(method, { id: selected, ...patch }); if (method === 'delete') { projectSelection.select(); setContext(null) } else setContext(value); await refresh(); setError('') }
    catch (error) { setError(String(error)); return false } finally { setPending(false) }
  }
  return <>{error && <p role="alert">{error}</p>}{selected ? <>
    <CrumbBand backTo={uiText('assistant.project.projects')} current={context?.project.name ?? ''} onBack={() => projectSelection.select()} />
    {!context && <Status loading pending={pending} error={error} />}
    {context && <><Status pending={pending} /><SettingsRow title={words('name')}><SavedText label={words('name')} value={context.project.name} disabled={pending} onSave={name => perform('update', { name: name.trim() })} /></SettingsRow><ConfigurationLinks scope="project" id={context.project.id} /><h4 className="settings-label">{uiText('assistant.settings.workingFolders')}</h4>
      {context.roots.map(root => <SettingsRow key={root.id} title={root.name} description={root.path}><Button variant="ghost" disabled={pending} onClick={() => void perform('removeFolder', { rootId: root.id })}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><X />{uiText('assistant.project.removeFolder')}</span></Button></SettingsRow>)}
      <SettingsRow title={uiText('assistant.project.addFolder')}><Button disabled={pending} onClick={() => void perform('addFolder')}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus />{uiText('assistant.project.addFolder')}</span></Button></SettingsRow>
      <SettingsRow className="assistant-danger-row" title={uiText('assistant.project.delete')} description={uiText('assistant.project.deleteDetail')}>{deleting ? <RowControl><Button variant="danger" disabled={pending} onClick={() => void perform('delete')}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Trash />{uiText('assistant.project.delete')}</span></Button><Button variant="ghost" disabled={pending} onClick={() => setDeleting(false)}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><X />{uiText('assistant.project.cancel')}</span></Button></RowControl> : <Button variant="danger" disabled={pending} onClick={() => setDeleting(true)}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Trash />{uiText('assistant.project.delete')}</span></Button>}</SettingsRow>
    </>}
  </> : <ListPage title={uiText('assistant.project.projects')}>{projects.map(project => <ListRow key={project.id} glyph={<Folder />} name={project.name} sub={uiText('assistant.project.folders', { count: project.folders.length })} onOpen={() => projectSelection.select(project.id)} />)}{!loaded && !error && <Status loading />}{loaded && !projects.length && <p className="assistant-empty">{uiText('assistant.settings.noProjects')}</p>}</ListPage>}</>
}

const ConnectionDetail: FC<{ channel: ChannelInfo; onBack(): void; onChanged(): Promise<void> }> = ({ channel, onBack, onChanged }) => {
  const [secrets, setSecrets] = React.useState<Record<string, string>>({}), [error, setError] = React.useState(''), [confirmDelete, setConfirmDelete] = React.useState(false)
  const [pending, setPending] = React.useState(false), [chats, setChats] = React.useState<AiChatSummary[]>([]), [selected, setSelected] = React.useState<string | null>(null)
  const refreshChats = React.useCallback(async () => { const result = await api.assistant.listChats(); if (!result.ok) throw new Error(result.error); setChats((result.data?.chats ?? []).filter(chat => chat.channelId === channel.id)) }, [channel.id])
  React.useEffect(() => { void refreshChats().catch(error => setError(String(error))) }, [refreshChats])
  const run = async (operation: () => Promise<{ ok: boolean; error?: string }>) => {
    if (pending) return false
    setPending(true)
    try { const result = await operation(); if (!result.ok) throw new Error(result.error); setError(''); await onChanged() } catch (error) { setError(String(error)); return false } finally { setPending(false) }
  }
  const choices = useChoices()
  const patch = (value: Parameters<typeof api.channels.setConfig>[1]) => run(() => api.channels.setConfig(channel.id, value))
  const current = chats.find(chat => chat.id === selected)
  if (current) return <ChatDetail summary={current} personalities={[]} connections={[]} backTo={channel.displayName} onBack={() => setSelected(null)} onChanged={refreshChats} />
  const fields: Array<{ key: 'token' | 'verifyToken' | 'appSecret'; label: string }> = channel.type === 'whatsapp' ? [{ key: 'token', label: uiText('auto.f69d5c7e6ea9') }, { key: 'verifyToken', label: uiText('auto.f952bc03ff37') }, { key: 'appSecret', label: uiText('auto.b2bd6aa20a30') }] : [{ key: 'token', label: uiText('auto.617a9b4cdbe6') }]
  return <><CrumbBand backTo={channel.type === 'telegram' ? 'Telegram' : 'WhatsApp'} current={channel.displayName} onBack={onBack} />
    <Status pending={pending} error={error || choices.error} />
    <Section title={words('connection')}>
      <SettingsRow title={words('name')}><SavedText label={words('name')} value={channel.displayName} disabled={pending} onSave={name => run(() => api.channels.rename(channel.id, name.trim()))} /></SettingsRow>
      <SettingsRow title={words('allowFrom')} description={words('allowFromHelp')}><SavedText label={words('allowFrom')} value={(channel.allowFrom ?? []).join(', ')} disabled={pending} onSave={value => patch({ allowFrom: value.split(',').map(item => item.trim()).filter(Boolean) })} /></SettingsRow>
      {channel.type === 'whatsapp' && (['phoneNumberId', 'graphVersion', 'webhookPort', 'publicCallbackUrl'] as const).map(key => <SettingsRow key={key} title={words(key)}><SavedText label={words(key)} value={String(channel[key] ?? '')} disabled={pending} onSave={value => patch({ [key]: value.trim() ? key === 'webhookPort' ? Number(value) : value.trim() : null })} /></SettingsRow>)}
    </Section>
    <Section title={words('defaults')}>
      <SettingsRow title={words('defaultProfileId')}><Select ariaLabel={words('defaultProfileId')} disabled={pending} value={channel.defaultProfile ?? ''} options={profileOptions(choices.value?.profiles ?? [], channel.defaultProfile ?? '')} onChange={value => { void patch({ defaultProfile: value || null }) }} /></SettingsRow>
      <SettingsRow title={words('defaultModel')}><Select ariaLabel={words('defaultModel')} disabled={pending} value={modelValue(channel.defaultRouting?.default)} options={modelOptions(choices.value?.connections ?? [], modelValue(channel.defaultRouting?.default))} onChange={value => {
        const model = parseModelValue(value, choices.value?.connections ?? [])
        if (value && !model) return
        void patch({ defaultRouting: model ? { ...(channel.defaultRouting ?? { auto: false, rules: [] }), default: model } : null })
      }} /></SettingsRow>
    </Section>
    <ConfigurationLinks scope="channel" id={channel.id} />
    <h4 className="settings-label">{words('credentials')}</h4>
    {fields.map(field => <SettingsRow key={field.key} title={field.label} description={uiText('assistant.configuration.credentials')}><RowControl><TextField type="password" value={secrets[field.key] ?? ''} ariaLabel={field.label} onChange={value => setSecrets({ ...secrets, [field.key]: value })} /><Button disabled={pending || !secrets[field.key]} onClick={() => { void run(async () => { const result = field.key === 'token' ? await api.channels.setSecret(channel.id, secrets[field.key]) : await api.channels.setSecretField(channel.id, field.key, secrets[field.key]); if (result.ok) setSecrets(current => ({ ...current, [field.key]: '' })); return result }) }}>{uiText('auto.efc007a393f6')}</Button></RowControl></SettingsRow>)}
    {channel.error && <p role="alert">{channel.error}</p>}
    <SettingsRow title={channel.connected ? uiText('assistant.configuration.connected') : uiText('assistant.configuration.disconnected')}><RowControl><Button disabled={pending} onClick={() => void run(() => channel.running ? api.channels.stop(channel.id) : api.channels.start(channel.id))}>{channel.running ? uiText('auto.9e253470c876') : uiText('auto.952f375412e8')}</Button>{confirmDelete ? <><Button variant="danger" disabled={pending} onClick={() => void run(async () => { const result = await api.channels.remove(channel.id); if (result.ok) onBack(); return result })}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Trash />{uiText('auto.2a8865aab33b')}</span></Button><Button variant="ghost" onClick={() => setConfirmDelete(false)}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><X />{uiText('auto.77dfd2135f4d')}</span></Button></> : <Button variant="ghost" onClick={() => setConfirmDelete(true)}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Trash />{uiText('auto.e963907dac5c')}</span></Button>}</RowControl></SettingsRow>
    <ListPage title={uiText('auto.0c6a9d1088dc')}>{!chats.length && <p className="assistant-empty">{uiText('auto.265928933f22')}</p>}{chats.map(chat => <ListRow key={chat.id} glyph={<Chat />} name={chat.title} sub={chat.channelIdentity ?? ''} onOpen={() => setSelected(chat.id)} />)}</ListPage>
  </>
}

const ChannelPane: FC<{ type: 'telegram' | 'whatsapp' }> = ({ type }) => {
  const [channels, setChannels] = React.useState<ChannelInfo[]>([]), [selected, setSelected] = React.useState<string | null>(null), [error, setError] = React.useState(''), [loaded, setLoaded] = React.useState(false), [adding, setAdding] = React.useState(false)
  const refresh = React.useCallback(async () => { const result = await api.channels.list(); if (!result.ok) throw new Error(result.error); setChannels(result.data?.channels ?? []); setLoaded(true); setError('') }, [])
  React.useEffect(() => {
    let live = true
    const update = () => { if (live) void refresh().catch(error => { if (live) setError(String(error)) }) }
    update()
    const off = api.backend.on('channels.changed', update), offFiles = api.data.files.onChanged(path => { if (path.endsWith('.md')) update() })
    return () => { live = false; off(); offFiles() }
  }, [refresh])
  const list = channels.filter(channel => channel.type === type), current = list.find(channel => channel.id === selected), label = type === 'telegram' ? 'Telegram' : 'WhatsApp'
  if (current) return <ConnectionDetail channel={current} onBack={() => setSelected(null)} onChanged={refresh} />
  const add = async () => { if (adding) return; setAdding(true); try { const result = await api.channels.add(type, `${label} ${list.length + 1}`); if (!result.ok) throw new Error(result.error); await refresh(); if (result.data?.id) setSelected(result.data.id) } catch (error) { setError(String(error)) } finally { setAdding(false) } }
  return <>{error && <p role="alert">{error}</p>}<ListPage title={uiText('auto.8f3509b64e0e')} addLabel={uiText('assistant.configuration.addConnection')} onAdd={() => void add()}><Status loading={!loaded && !error} pending={adding} />{loaded && !list.length && <p className="assistant-empty">{uiText('auto.032029fdbd4e')}</p>}{list.map(channel => <ListRow key={channel.id} glyph={type === 'telegram' ? <Telegram /> : <WhatsApp />} name={channel.displayName} sub={channel.connected ? uiText('assistant.configuration.connected') : uiText('assistant.configuration.disconnected')} onOpen={() => setSelected(channel.id)} />)}</ListPage></>
}

export const Settings: FC<{ section?: string }> = ({ section }) => {
  if (section === 'evaluations') return <div className="assistant-settings"><AiHarnessesSection /></div>
  return <div className="assistant-settings">{section === 'projects' ? <ProjectsPane /> : section === 'telegram' || section === 'whatsapp' ? <ChannelPane type={section} /> : section === 'chat' ? <><ChatPreferences /><ConfigurationLinks scope="chat" /></> : <><ConfigurationLinks /><Personalities /><SpeechPreferences /><Storage /></>}</div>
}
