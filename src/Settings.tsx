import { projectSelection, type ProjectContext } from './ProjectMode'
import { AiHarnessesSection } from './HarnessSettings'
import { React, api } from './runtime'
import type { FC, ReactNode } from 'react'
import type { AiChatSummary, AiChatThread, AiConnectionStatus, AiPersonality, AssistantProject, ChannelInfo } from './types'
import { useAssistant, useChannels } from './hooks'
import { Chat, Folder, ChevronLeft, ChevronRight, Telegram, WhatsApp, Trash, X, Plus, FolderOpen } from './icons'
import { uiText } from './localization'
import { ChatPreferences, ChannelVisibility, AttachmentFolder, SpeechPreferences, Personalities, Storage, Section, Status, ErrorNotice, cleanErrorMessage, SavedText, Select, words, useChoices, modelOptions, profileOptions } from './Preferences'
import { modelValue, parseModelValue } from './models'
import { LuPlus, RiVoiceAiFill, LuBot, LuExternalLink, LuSettings, LuPlay } from './settingsIcons'
import { changeConversation, readConversation, updateConversation } from './commands'
import type { ConfigurationStatus, ConfigurationDraft, ConfigurationNote } from './backend/configuration'

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

export const ConfigurationLinks: FC<{ scope?: 'settings' | 'instructions' | 'chat' | 'channel' | 'conversation' | 'project'; id?: string; compact?: boolean }> = ({ scope = 'settings', id, compact }) => {
  const [status, setStatus] = React.useState<ConfigurationStatus | null>(null)
  const [error, setError] = React.useState('')
  const [choosing, setChoosing] = React.useState<string | null>(null)
  const [choice, setChoice] = React.useState(''), [choiceRevision, setChoiceRevision] = React.useState<number>()
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
    try { await api.backend.call('configuration.link', { key: choosing, path: choice, expectedRevision: choiceRevision }); setChoosing(null); await refresh() }
    catch (error) { setError(String(error)) } finally { setSaving(false) }
  }
  const Row = compact ? PropertyRow : SettingsRow
  return <>
    {!status && !error && <Status loading />}
    {!compact && <p className="settings-description">{words('notesHelp')}</p>}
    {error && <ErrorNotice error={error} />}
    {status?.diagnostics.map(diagnostic => <ErrorNotice key={diagnostic.path} error={`${diagnostic.message}${diagnostic.retained ? ` · ${uiText('assistant.configuration.retained')}` : ''}`} />)}
    {(['instructions', 'files'] as const).map(group => {
      const notes = status?.notes.filter(note => note.group === group) ?? []
      return notes.length ? <React.Fragment key={group}>{!compact && <h4 className="settings-label">{words(group)}</h4>}{notes.map(note => <Row key={note.id} title={uiText(`assistant.configuration.note.${note.id}`)} description={note.path}>
        <RowControl><Button variant="ghost" size="small" onClick={() => api.workspace.openFile(note.path)}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><FolderOpen />{uiText('auto.cf9b77061f7b')}</span></Button>{note.key && <Button variant="ghost" size="small" onClick={() => { setChoosing(note.key!); setChoice(note.path); setChoiceRevision(status?.settingsRevision) }}>{uiText('assistant.configuration.choose')}</Button>}</RowControl>
      </Row>)}</React.Fragment> : null
    })}
    {choosing && <api.ui.Modal title={uiText('assistant.configuration.choose')} size="small" onClose={() => { if (!saving) setChoosing(null) }} footer={<Button disabled={saving || !choice} onClick={() => void choose()}>{uiText('auto.501e8582e34a')}</Button>}>
      <api.ui.ResourcePicker value={choice} onChange={value => setChoice(value)} kinds={['file']} filters={{ extension: 'md' }} allowCustom={false} ariaLabel={uiText('assistant.configuration.choose')} />
    </api.ui.Modal>}
  </>
}

type InstructionScope = 'instructions' | 'conversation' | 'channel'

const InstructionEditor: FC<{ scope: InstructionScope; id?: string; note: ConfigurationNote; compact?: boolean }> = ({ scope, id, note, compact }) => {
  const [draft, setDraft] = React.useState<ConfigurationDraft>(), [body, setBody] = React.useState(''), [includes, setIncludes] = React.useState<string[]>([])
  const [error, setError] = React.useState(''), [pending, setPending] = React.useState(false), [include, setInclude] = React.useState('')
  const [choosing, setChoosing] = React.useState(false), [linkedOpen, setLinkedOpen] = React.useState(false), [path, setPath] = React.useState(note.path), [choiceRevision, setChoiceRevision] = React.useState<number>()
  const read = React.useCallback(async () => {
    const next = await api.backend.call<ConfigurationDraft>('configuration.note', { scope, id, noteId: note.id })
    setDraft(next); setBody(next.body); setIncludes(next.includes); setError('')
  }, [scope, id, note.id, note.path])
  React.useEffect(() => { let live = true; void api.backend.call<ConfigurationDraft>('configuration.note', { scope, id, noteId: note.id }).then(next => { if (live) { setDraft(next); setBody(next.body); setIncludes(next.includes) } }).catch(error => { if (live) setError(String(error)) }); return () => { live = false } }, [read])
  const save = async () => {
    if (!draft || pending) return
    setPending(true)
    try { const next = await api.backend.call<ConfigurationDraft>('configuration.note.set', { scope, id, noteId: note.id, body, includes, expectedRevision: draft.revision }); setDraft(next); setBody(next.body); setError('') }
    catch (error) { setError(String(error)) } finally { setPending(false) }
  }
  const dirty = draft && (body !== draft.body || JSON.stringify(includes) !== JSON.stringify(draft.includes))
  return <div className={`assistant-instruction-editor${compact ? ' compact' : ''}`}>
    <Status loading={!draft && !error} pending={pending} error={error} />
    {draft && <>
      <p className="settings-description">{uiText(`assistant.instructions.help.${note.id}`)}</p>
      <label className="assistant-instruction-label">{words('instructions')}<textarea className="assistant-instruction-text" value={body} disabled={pending} onChange={event => setBody(event.target.value)} spellCheck={false} /></label>
      <section className="assistant-instruction-links"><button type="button" className="assistant-property-heading" aria-expanded={linkedOpen} onClick={() => setLinkedOpen(!linkedOpen)}><ChevronRight className={linkedOpen ? 'expanded' : ''} />{words('linkedNotes')}{includes.length ? ` · ${includes.length}` : ''}</button>{linkedOpen && <>
        {includes.map((path, index) => <div key={`${index}:${path}`} className="assistant-instruction-link"><span>{path}</span><button type="button" className="assistant-iconbtn" aria-label={`${words('remove')}: ${path}`} disabled={pending} onClick={() => setIncludes(includes.filter((_, i) => i !== index))}><X /></button></div>)}
        <div className="assistant-instruction-link"><api.ui.ResourcePicker value={include} onChange={setInclude} kinds={['file']} filters={{ extension: 'md' }} allowCustom={false} ariaLabel={words('linkedNotes')} /><Button size="small" disabled={pending || !include || includes.includes(include)} onClick={() => { setIncludes([...includes, include]); setInclude('') }}>{words('add')}</Button></div>
      </>}</section>
      <div className="assistant-instruction-actions"><Button size="small" disabled={pending || !dirty} onClick={() => void save()}>{uiText('auto.efc007a393f6')}</Button><Button size="small" variant="ghost" disabled={pending} onClick={() => void read().catch(error => setError(String(error)))}>{words('reload')}</Button><span className="assistant-instruction-count">{new TextEncoder().encode(body).length.toLocaleString()} {words('bytes')}</span></div>
      <div className="assistant-instruction-source"><span title={draft.path}>{draft.path.split('/').pop()}</span><Button size="small" variant="ghost" onClick={() => api.workspace.openFile(draft.path)}>{words('openNote')}</Button>{note.key && <Button size="small" variant="ghost" onClick={() => { setPath(draft.path); setChoiceRevision(draft.settingsRevision); setChoosing(true) }}>{uiText('assistant.configuration.choose')}</Button>}</div>
    </>}
    {choosing && <api.ui.Modal title={uiText('assistant.configuration.choose')} size="small" onClose={() => setChoosing(false)} footer={<Button disabled={pending || !path} onClick={() => { setPending(true); void api.backend.call('configuration.link', { key: note.key, path, expectedRevision: choiceRevision }).then(() => { setChoosing(false); return read() }).catch(error => setError(String(error))).finally(() => setPending(false)) }}>{uiText('auto.efc007a393f6')}</Button>}><api.ui.ResourcePicker value={path} onChange={setPath} kinds={['file']} filters={{ extension: 'md' }} allowCustom={false} ariaLabel={uiText('assistant.configuration.choose')} /></api.ui.Modal>}
  </div>
}

const InstructionsPane: FC = () => {
  const [status, setStatus] = React.useState<ConfigurationStatus>(), [selected, setSelected] = React.useState<string>(), [error, setError] = React.useState('')
  React.useEffect(() => { let live = true; const refresh = () => { void api.backend.call<ConfigurationStatus>('configuration.status', { scope: 'instructions' }).then(value => { if (live) setStatus(value) }).catch(error => { if (live) setError(String(error)) }) }; refresh(); const off = api.backend.on('configuration.changed', refresh); return () => { live = false; off() } }, [])
  const current = status?.notes.find(note => note.id === selected)
  return <><Status loading={!status && !error} error={error} />{status?.diagnostics.map(diagnostic => <ErrorNotice key={diagnostic.path} error={`${diagnostic.message}${diagnostic.retained ? ` · ${uiText('assistant.configuration.retained')}` : ''}`} />)}{current ? <><CrumbBand backTo={words('instructions')} current={uiText(`assistant.configuration.note.${current.id}`)} onBack={() => setSelected(undefined)} /><InstructionEditor key={current.path} scope="instructions" note={current} /></> : <><p className="settings-description">{words('readyInstructions')}</p><div className="assistant-instruction-list">{status?.notes.filter(note => note.group === 'instructions').map(note => <ListRow key={note.id} glyph={note.id === 'global' ? <LuBot /> : note.id === 'external' ? <LuExternalLink /> : note.id === 'tools' ? <LuSettings /> : note.id === 'voice' ? <RiVoiceAiFill /> : note.id === 'plan' ? <LuPlay /> : note.id === 'telegram' ? <Telegram /> : note.id === 'whatsapp' ? <WhatsApp /> : note.id === 'chatNaming' ? <Chat /> : <FolderOpen />} name={uiText(`assistant.configuration.note.${note.id}`)} sub={uiText(`assistant.instructions.help.${note.id}`)} onOpen={() => setSelected(note.id)} />)}</div></>}</>
}

const ContextInstructions: FC<{ scope: 'conversation' | 'channel'; id: string }> = ({ scope, id }) => {
  const [status, setStatus] = React.useState<ConfigurationStatus>(), [error, setError] = React.useState('')
  React.useEffect(() => { let live = true; void api.backend.call<ConfigurationStatus>('configuration.status', { scope, id }).then(value => { if (live) setStatus(value) }).catch(error => { if (live) setError(String(error)) }); return () => { live = false } }, [scope, id])
  return <><Status loading={!status && !error} error={error} />{status?.notes.filter(note => note.group === 'instructions').map(note => <InstructionEditor key={note.path} scope={scope} id={id} note={note} compact />)}</>
}

const PropertySection: FC<{ title: string; children: ReactNode }> = ({ title, children }) => {
  const [open, setOpen] = React.useState(false)
  return <section className="assistant-property-section"><button type="button" className="assistant-property-heading" aria-expanded={open} onClick={() => setOpen(!open)}><ChevronRight className={open ? 'expanded' : ''} />{title}</button>{open && <div className="assistant-property-body">{children}</div>}</section>
}

const PropertyRow: typeof api.ui.settings.Row = ({ title, description, children }) => <div className="assistant-property-row"><div className="assistant-property-label" title={typeof description === 'string' ? description : undefined}>{title}</div><div className="assistant-property-control">{children}</div></div>

export const ChatDetail: FC<{ summary: AiChatSummary; personalities: AiPersonality[]; connections: AiConnectionStatus[]; backTo: string; onBack: () => void; onChanged: () => Promise<void>; embedded?: boolean }> = ({ summary, backTo, onBack, onChanged, embedded }) => {
  const { snap, store } = useAssistant(), Row = embedded ? PropertyRow : SettingsRow
  const choices = useChoices(), { channels } = useChannels()
  const channel = channels.find(channel => channel.id === summary.channelId)
  const [thread, setThread] = React.useState<AiChatThread | null>(null), [error, setError] = React.useState(''), [confirmDelete, setConfirmDelete] = React.useState(false)
  React.useEffect(() => {
    const current = store.getSnapshot().active
    if (current?.id === summary.id) { setThread(current); return }
    let live = true
    void readConversation(api, summary.id).then(value => { if (live) setThread(value) }).catch(error => { if (live) setError(String(error)) })
    return () => { live = false }
  }, [summary.id, store])
  const action = async (run: () => Promise<unknown>) => { try { await run(); await onChanged(); setError('') } catch (error) { setError(String(error)) } }
  return <>
    {!embedded && <CrumbBand backTo={backTo} current={summary.title} onBack={onBack} />}
    {error && <ErrorNotice error={error} />}
    {thread && <>
      <Row title={uiText('assistant.permissions.heading')}><api.ui.settings.SelectField value={snap.dangerous?.enabled ? 'full' : 'vault'} ariaLabel={uiText('assistant.permissions.heading')} options={[{ value: 'vault', label: uiText('assistant.permissions.vault') }, { value: 'full', label: uiText('assistant.permissions.full') }]} onChange={value => { void action(() => store.setAccessMode(value === 'full' ? 'full' : 'vault')) }} /></Row>
      <Row title={uiText('assistant.surface.title')}><TextField value={thread.title} ariaLabel={uiText('assistant.surface.title')} onChange={title => setThread({ ...thread, title })} onCommit={title => { void action(() => store.renameChat(thread.id, title)) }} /></Row>
      <Row title={uiText('assistant.surface.pinned')}><Toggle checked={thread.pinned === true} label={uiText('assistant.surface.pinned')} onChange={pinned => { setThread({ ...thread, pinned }); void action(() => store.setPinned(thread.id, pinned)) }} /></Row>
      <PropertySection title={words('behavior')}>
        <Row title={words('defaultModel')}><Select ariaLabel={words('defaultModel')} value={modelValue(thread.model)} options={modelOptions(choices.value?.connections ?? [], modelValue(thread.model))} onChange={value => { void action(async () => { const model = parseModelValue(value, choices.value?.connections ?? []); if (value && !model) return; const result = await updateConversation(api, thread.id, { model: model ?? null }); setThread(result.value) }) }} /></Row>
        <Row title={words('defaultProfileId')}><Select ariaLabel={words('defaultProfileId')} value={thread.profileId ?? ''} options={profileOptions(choices.value?.profiles ?? [], thread.profileId ?? '')} onChange={profileId => { void action(async () => { const result = await updateConversation(api, thread.id, { profileId }); setThread(result.value) }) }} /></Row>
        <Row title={words('attachmentParser')}><Select ariaLabel={words('attachmentParser')} value={thread.attachmentParser ?? ''} options={[...modelOptions(choices.value?.connections ?? [], thread.attachmentParser ?? ''), ...(!thread.attachmentParser || thread.attachmentParser !== 'markitdown' ? [{ value: 'markitdown', label: 'MarkItDown' }] : [])]} onChange={attachmentParser => { void action(async () => { const result = await updateConversation(api, thread.id, { attachmentParser }); setThread(result.value) }) }} /></Row>
      </PropertySection>
      <PropertySection title={words('instructions')}>{thread.instructionsPath ? <ContextInstructions scope="conversation" id={thread.id} /> : <p className="settings-description">{words('unsavedInstructions')}</p>}</PropertySection>
      {channel && <PropertySection title={words('connectionDefaults')}>
        <p className="settings-description">{channel.displayName}</p>
        <Row title={words('defaultProfileId')}><Select ariaLabel={words('connectionPersonality')} value={channel.defaultProfile ?? ''} options={profileOptions(choices.value?.profiles ?? [], channel.defaultProfile ?? '')} onChange={value => { void action(async () => { const result = await api.channels.setConfig(channel.id, { defaultProfile: value || null }, channel.configurationRevisions); if (!result.ok) throw new Error(result.error) }) }} /></Row>
        <Row title={words('defaultModel')}><Select ariaLabel={words('connectionModel')} value={modelValue(channel.defaultRouting?.default)} options={modelOptions(choices.value?.connections ?? [], modelValue(channel.defaultRouting?.default))} onChange={value => { void action(async () => { const model = parseModelValue(value, choices.value?.connections ?? []); if (value && !model) return; const result = await api.channels.setConfig(channel.id, { defaultRouting: model ? { ...(channel.defaultRouting ?? { auto: false, rules: [] }), default: model } : null }, channel.configurationRevisions); if (!result.ok) throw new Error(result.error) }) }} /></Row>
        <ContextInstructions scope="channel" id={channel.id} />
      </PropertySection>}
      <PropertySection title={words('attachmentDefaults')}><AttachmentFolder compact /></PropertySection>
      <Row title=""><RowControl>{confirmDelete ? <><Button variant="danger" onClick={() => { void action(async () => { await changeConversation(api, thread.id, 'delete-chat'); onBack() }) }}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Trash />{uiText('auto.c9f2829e382c')}</span></Button><Button variant="ghost" onClick={() => setConfirmDelete(false)}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><X />{uiText('auto.77dfd2135f4d')}</span></Button></> : <Button variant="ghost" onClick={() => setConfirmDelete(true)}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Trash />{uiText('auto.db9121e79c1c')}</span></Button>}</RowControl></Row>
    </>}
  </>
}

const ProjectForm: FC<{ context: ProjectContext; pending: boolean; perform(method: string, patch?: Record<string, unknown>): Promise<false | undefined> }> = ({ context, pending, perform }) => {
  const [name, setName] = React.useState(context.project.name), [instructions, setInstructions] = React.useState(context.project.instructions)
  const [dirty, setDirty] = React.useState(false), [saved, setSaved] = React.useState(false), [deleting, setDeleting] = React.useState(false)
  React.useEffect(() => { if (!dirty) { setName(context.project.name); setInstructions(context.project.instructions) } }, [context.project.name, context.project.instructions, dirty])
  const edit = () => { setDirty(true); setSaved(false) }
  return <div className="assistant-project-form">
    <p className="settings-description">{uiText('assistant.project.setupHelp')}</p>
    <SettingsRow title={words('name')}><RowControl><TextField ariaLabel={words('name')} value={name} disabled={pending} onChange={value => { setName(value); edit() }} /></RowControl></SettingsRow>
    <section className="assistant-project-section">
      <div className="assistant-project-section-head"><Folder /><h4>{uiText('assistant.settings.workingFolders')}</h4><button type="button" className="assistant-btn assistant-btn-ghost" disabled={pending} onClick={() => void perform('addFolder')}><Plus />{uiText('assistant.project.addFolder')}</button></div>
      <p className="settings-description">{uiText('assistant.project.folderHelp')}</p>
      {!context.roots.length && <div className="assistant-project-empty">{uiText('assistant.project.noFolders')}</div>}
      {context.roots.map(root => <div className="assistant-project-folder" key={root.id}><FolderOpen /><div><strong>{root.name}</strong><span>{root.path}</span></div><button type="button" className="assistant-iconbtn" disabled={pending} aria-label={`${uiText('assistant.project.removeFolder')}: ${root.name}`} title={uiText('assistant.project.removeFolder')} onClick={() => void perform('removeFolder', { rootId: root.id })}><X /></button></div>)}
    </section>
    <section className="assistant-project-section">
      <div className="assistant-project-section-head"><LuBot /><h4>{uiText('assistant.configuration.note.project')}</h4></div>
      <p className="settings-description">{uiText('assistant.project.instructionHelp')}</p>
      <textarea className="assistant-instruction-text" aria-label={uiText('assistant.configuration.note.project')} placeholder={uiText('assistant.project.instructionPlaceholder')} value={instructions} disabled={pending} onChange={event => { setInstructions(event.target.value); edit() }} />
    </section>
    <div className="assistant-connection-footer"><button type="button" className="assistant-connection-save" disabled={pending || !dirty || !name.trim()} onClick={() => { void perform('update', { name: name.trim(), instructions, expectedRevision: context.project.configurationRevision }).then(result => { if (result !== false) { setDirty(false); setSaved(true) } }) }}>{pending ? words('saving') : uiText('auto.efc007a393f6')}</button>{saved && <span className="assistant-connection-saved" role="status">{uiText('auto.f133b2924e9e')}</span>}</div>
    <PropertySection title={uiText('assistant.project.manage')}>
      <ConfigurationLinks scope="project" id={context.project.id} />
      <p className="settings-description">{uiText('assistant.project.deleteDetail')}</p>
      <div className="assistant-project-manage">{deleting ? <><button type="button" className="assistant-btn assistant-btn-ghost assistant-project-delete" disabled={pending} onClick={() => void perform('delete')}><Trash />{uiText('assistant.project.delete')}</button><button type="button" className="assistant-btn assistant-btn-ghost" disabled={pending} onClick={() => setDeleting(false)}><X />{uiText('assistant.project.cancel')}</button></> : <button type="button" className="assistant-btn assistant-btn-ghost assistant-project-delete" disabled={pending} onClick={() => setDeleting(true)}><Trash />{uiText('assistant.project.delete')}</button>}</div>
    </PropertySection>
  </div>
}

export const ProjectsPane: FC = () => {
  const selected = React.useSyncExternalStore(projectSelection.subscribe, projectSelection.getSnapshot)
  const [projects, setProjects] = React.useState<AssistantProject[]>([]), [context, setContext] = React.useState<ProjectContext | null>(null)
  const [pending, setPending] = React.useState(false), [error, setError] = React.useState(''), [loaded, setLoaded] = React.useState(false)
  const request = <T,>(method: string, payload?: unknown) => api.backend.call<T>('projects.request', { method, payload })
  const refresh = React.useCallback(async () => { setProjects(await api.backend.call<AssistantProject[]>('projects.request', { method: 'list' })); setLoaded(true) }, [])
  React.useEffect(() => { void refresh().catch(error => setError(String(error))); return api.backend.on('projects.changed', () => { void refresh().catch(error => setError(String(error))) }) }, [refresh])
  React.useEffect(() => {
    let live = true
    setContext(null)
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
  return <>{error && <ErrorNotice error={error} />}{selected ? <>
    <CrumbBand backTo={uiText('assistant.project.projects')} current={context?.project.name ?? ''} onBack={() => projectSelection.select()} />
    {!context && <Status loading pending={pending} error={error} />}
    {context && <ProjectForm key={context.project.id} context={context} pending={pending} perform={perform} />}
  </> : <ListPage title={uiText('assistant.project.projects')}>{projects.map(project => <ListRow key={project.id} glyph={<Folder />} name={project.name} sub={uiText('assistant.project.folders', { count: project.folders.length })} onOpen={() => projectSelection.select(project.id)} />)}{!loaded && !error && <Status loading />}{loaded && !projects.length && <p className="assistant-empty">{uiText('assistant.settings.noProjects')}</p>}</ListPage>}</>
}

const ConnectionDetail: FC<{ channel: ChannelInfo; onBack(): void; onChanged(): Promise<void> }> = ({ channel, onBack, onChanged }) => {
  const [secrets, setSecrets] = React.useState<Record<string, string>>({}), [error, setError] = React.useState(''), [confirmDelete, setConfirmDelete] = React.useState(false)
  const [draft, setDraft] = React.useState(() => ({ name: channel.displayName, allowFrom: (channel.allowFrom ?? []).join(', '), ...Object.fromEntries((['phoneNumberId', 'graphVersion', 'webhookPort', 'publicCallbackUrl'] as const).map(key => [key, String(channel[key] ?? '')])) } as Record<string, string>))
  const [pending, setPending] = React.useState(false), [dirty, setDirty] = React.useState(false), [saved, setSaved] = React.useState(false)
  const [draftRevision, setDraftRevision] = React.useState(channel.configurationRevisions)
  React.useEffect(() => { if (!dirty) setDraftRevision(channel.configurationRevisions) }, [channel.configurationRevisions, dirty])
  const busy = React.useRef(false)
  const run = async (operation: () => Promise<{ ok: boolean; error?: string }>) => {
    if (busy.current) return false
    busy.current = true; setPending(true); setSaved(false)
    try { const result = await operation(); if (!result.ok) throw new Error(result.error); setError(''); await onChanged(); return true } catch (error) { setError(String(error)); return false } finally { busy.current = false; setPending(false) }
  }
  const change = (key: string, value: string) => { setDraft(current => ({ ...current, [key]: value })); setDirty(true); setSaved(false) }
  const field = (key: string, label: string) => <RowControl><TextField ariaLabel={label} value={draft[key]} disabled={pending} onChange={value => change(key, value)} /></RowControl>
  const save = async () => {
    const ok = await run(async () => {
      const check = (result: { ok: boolean; error?: string }) => { if (!result.ok) throw new Error(result.error) }
      const config: Parameters<typeof api.channels.setConfig>[1] = { name: draft.name.trim(), allowFrom: draft.allowFrom.split(',').map(item => item.trim()).filter(Boolean) }
      if (channel.type === 'whatsapp') Object.assign(config, Object.fromEntries((['phoneNumberId', 'graphVersion', 'webhookPort', 'publicCallbackUrl'] as const).map(key => [key, draft[key].trim() ? key === 'webhookPort' ? Number(draft[key]) : draft[key].trim() : null])))
      const saved = await api.channels.setConfig(channel.id, config, draftRevision)
      check(saved)
      setDraftRevision(saved.data?.configurationRevisions)
      for (const key of ['token', 'verifyToken', 'appSecret'] as const) if (secrets[key]) {
        check(key === 'token' ? await api.channels.setSecret(channel.id, secrets[key]) : await api.channels.setSecretField(channel.id, key, secrets[key]))
        setSecrets(current => ({ ...current, [key]: '' }))
      }
      return { ok: true }
    })
    if (ok) { setDirty(false); setSaved(true) }
  }
  const fields: Array<{ key: 'token' | 'verifyToken' | 'appSecret'; label: string }> = channel.type === 'whatsapp' ? [{ key: 'token', label: uiText('auto.f69d5c7e6ea9') }, { key: 'verifyToken', label: uiText('auto.f952bc03ff37') }, { key: 'appSecret', label: uiText('auto.b2bd6aa20a30') }] : [{ key: 'token', label: uiText('auto.617a9b4cdbe6') }]
  return <><CrumbBand backTo={channel.type === 'telegram' ? 'Telegram' : 'WhatsApp'} current={channel.displayName} onBack={onBack} />
    <Section title={words('connection')}>
      <SettingsRow title={words('channelId')} description={channel.id} />
      <SettingsRow title={words('name')}>{field('name', words('name'))}</SettingsRow>
      <SettingsRow title={words('allowFrom')} description={words('allowFromHelp')}>{field('allowFrom', words('allowFrom'))}</SettingsRow>
      {channel.type === 'whatsapp' && (['phoneNumberId', 'graphVersion', 'webhookPort', 'publicCallbackUrl'] as const).map(key => <SettingsRow key={key} title={words(key)}>{field(key, words(key))}</SettingsRow>)}
    </Section>
    <h4 className="settings-label">{words('credentials')}</h4>
    {fields.map(field => <SettingsRow key={field.key} title={field.label} description={uiText('assistant.configuration.credentials')}><RowControl><TextField type="password" value={secrets[field.key] ?? ''} ariaLabel={field.label} disabled={pending} onChange={value => { setSecrets(current => ({ ...current, [field.key]: value })); setSaved(false) }} /></RowControl></SettingsRow>)}

    <SettingsRow title={channel.connected ? uiText('assistant.configuration.connected') : uiText('assistant.configuration.disconnected')}><RowControl><Button disabled={pending} onClick={() => void run(() => channel.running ? api.channels.stop(channel.id, channel.configurationRevisions) : api.channels.start(channel.id, channel.configurationRevisions))}>{channel.running ? uiText('auto.9e253470c876') : uiText('auto.952f375412e8')}</Button>{confirmDelete ? <><Button variant="danger" disabled={pending} onClick={() => void run(async () => { const result = await api.channels.remove(channel.id, draftRevision); if (result.ok) onBack(); return result })}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Trash />{uiText('auto.2a8865aab33b')}</span></Button><Button variant="ghost" onClick={() => setConfirmDelete(false)}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><X />{uiText('auto.77dfd2135f4d')}</span></Button></> : <Button variant="ghost" onClick={() => setConfirmDelete(true)}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Trash />{uiText('auto.e963907dac5c')}</span></Button>}</RowControl></SettingsRow>
    <div className="assistant-connection-footer">
      <button type="button" className="assistant-connection-save" disabled={pending || (!dirty && !Object.values(secrets).some(Boolean))} onClick={() => void save()}>{pending ? words('saving') : uiText('auto.efc007a393f6')}</button>
      {saved && <span className="assistant-connection-saved" role="status">{uiText('auto.f133b2924e9e')}</span>}
      {channel.configurationApplication && <p className="assistant-connection-error" role="status">{channel.configurationApplication.reason}</p>}
      {(error || channel.error) && <p className="assistant-connection-error" role="alert">{cleanErrorMessage(error || channel.error || '')}</p>}
    </div>

  </>
}

const ChannelPane: FC<{ type: 'telegram' | 'whatsapp' }> = ({ type }) => {
  const [configurationRevisions, setConfigurationRevisions] = React.useState<Record<string, number>>()
  const [channels, setChannels] = React.useState<ChannelInfo[]>([]), [selected, setSelected] = React.useState<string | null>(null), [error, setError] = React.useState(''), [loaded, setLoaded] = React.useState(false), [adding, setAdding] = React.useState(false)
  const refresh = React.useCallback(async () => { const result = await api.channels.list(); if (!result.ok) throw new Error(result.error); setChannels(result.data?.channels ?? []); setConfigurationRevisions(result.data?.configurationRevisions); setLoaded(true); setError('') }, [])
  React.useEffect(() => {
    let live = true
    const update = () => { if (live) void refresh().catch(error => { if (live) setError(String(error)) }) }
    update()
    const off = api.backend.on('channels.changed', update), offFiles = api.data.files.onChanged(path => { if (path.endsWith('.md')) update() })
    return () => { live = false; off(); offFiles() }
  }, [refresh])
  const list = channels.filter(channel => channel.type === type), current = list.find(channel => channel.id === selected), label = type === 'telegram' ? 'Telegram' : 'WhatsApp'
  if (current) return <ConnectionDetail key={current.id} channel={current} onBack={() => setSelected(null)} onChanged={refresh} />
  const add = async () => { if (adding) return; setAdding(true); try { const result = await api.channels.add(type, `${label} ${list.length + 1}`, configurationRevisions); if (!result.ok) throw new Error(result.error); await refresh(); if (result.data?.id) setSelected(result.data.id) } catch (error) { setError(String(error)) } finally { setAdding(false) } }
  return <>{error && <ErrorNotice error={error} />}<ListPage title={uiText('auto.8f3509b64e0e')} addLabel={uiText('assistant.configuration.addConnection')} onAdd={() => void add()}><Status loading={!loaded && !error} pending={adding} />{loaded && !list.length && <p className="assistant-empty">{uiText('auto.032029fdbd4e')}</p>}{list.map(channel => <ListRow key={channel.id} glyph={type === 'telegram' ? <Telegram /> : <WhatsApp />} name={channel.displayName} sub={channel.connected ? uiText('assistant.configuration.connected') : uiText('assistant.configuration.disconnected')} onOpen={() => setSelected(channel.id)} />)}</ListPage></>
}

export const Settings: FC<{ section?: string }> = ({ section }) => {
  if (section === 'evaluations') return <div className="assistant-settings"><AiHarnessesSection /></div>
  return <div className="assistant-settings">{section === 'projects' ? <ProjectsPane /> : section === 'telegram' || section === 'whatsapp' ? <ChannelPane type={section} /> : section === 'instructions' ? <InstructionsPane /> : section === 'voice' ? <SpeechPreferences /> : section === 'chat' ? <ChatPreferences /> : <>
    <Section title={words('channels')}><ChannelVisibility /></Section>
    <ListPage title={words('customize')}><ListRow glyph={<FolderOpen />} name={words('instructions')} sub={uiText('assistant.instructions.description')} onOpen={() => api.workspace.openSettings('plugin:assistant#instructions')} /><ListRow glyph={<RiVoiceAiFill />} name={words('voiceProvider')} sub={uiText('assistant.instructions.voiceDescription')} onOpen={() => api.workspace.openSettings('plugin:assistant#voice')} /></ListPage>
    <Personalities /><Storage />
  </>}</div>
}
