import type { AssistantProject, AiChatSummary } from './types'
import type { ProjectRoot } from '@valley/plugin-sdk/pluginExecution'
import { api, React } from './runtime'
import { LuSettings } from './settingsIcons'
import { uiText } from './localization'
import { Folder, FolderOpen, Plus, X, ChevronRight, Compose } from './icons'

export interface ProjectContext { project: AssistantProject; roots: ProjectRoot[] }
let selectedProject: string | undefined
const projectListeners = new Set<() => void>()
export const projectSelection = {
  subscribe(listener: () => void) { projectListeners.add(listener); return () => { projectListeners.delete(listener) } },
  getSnapshot() { return selectedProject },
  select(id?: string) { selectedProject = id; for (const listener of projectListeners) listener() }
}
export function openProjectSettings(id: string): void {
  projectSelection.select(id)
  api.workspace.openSettings('plugin:assistant#projects')
}
const request = <T,>(method: string, payload?: unknown): Promise<T> => api.backend.call<T>('projects.request', { method, payload })
export function ProjectMode({ projectId, chats, busy, onSelect, onNewChat, onOpen, renderChat, activeChatId, onActiveChatVisibleChange, query = '', onProjectsChange }: {
  activeChatId?: string; onActiveChatVisibleChange?(visible: boolean): void
  renderChat?(chat: AiChatSummary): import('react').ReactNode; query?: string; onProjectsChange?(projects: AssistantProject[]): void
  projectId?: string; chats: AiChatSummary[]; busy: boolean; onSelect(id?: string): Promise<void>; onNewChat(id: string): void; onOpen(id: string): void
}): React.ReactElement {
  const [projects, setProjects] = React.useState<AssistantProject[]>([])
  const [collapsed, setCollapsed] = React.useState(false)
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({})
  const [showAll, setShowAll] = React.useState<Record<string, boolean>>({})
  const activeChatVisible = !collapsed && projects.some(project => (expanded[project.id] ?? projectId === project.id) &&
    chats.filter(chat => chat.projectId === project.id).slice(0, showAll[project.id] ? undefined : 5).some(chat => chat.id === activeChatId))
  React.useEffect(() => { onActiveChatVisibleChange?.(activeChatVisible) }, [activeChatVisible, onActiveChatVisibleChange])
  const [name, setName] = React.useState('')
  const [creating, setCreating] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState('')
  React.useEffect(() => { let current = true; void request<AssistantProject[]>('list').then(value => { if (current) setProjects(value) }).catch(error => { if (current) setError(String(error)) }); return () => { current = false } }, [projectId])
  React.useEffect(() => { onProjectsChange?.(projects) }, [projects, onProjectsChange])
  React.useEffect(() => api.backend.on('projects.changed', () => { void request<AssistantProject[]>('list').then(setProjects).catch(error => setError(String(error))) }), [])
  const perform = async (work: () => Promise<void>): Promise<void> => {
    setPending(true); setError('')
    try { await work() } catch (error) { setError(error instanceof Error ? error.message : String(error)) } finally { setPending(false) }
  }
  const create = (): void => {
    if (!name.trim() || busy || pending) return
    void perform(async () => { const created = await request<AssistantProject>('create', { name }); setProjects(current => [...current, created]); setCreating(false); setName(''); await onSelect(created.id) })
  }
  const disabled = busy || pending
  return <div className="assistant-projects">
    <div className="assistant-project-section-heading">
      <button className="assistant-section-toggle" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>{uiText('assistant.project.projects')}<ChevronRight className={collapsed ? '' : 'is-expanded'} /></button>
      <button className="assistant-iconbtn" title={uiText('assistant.project.new')} aria-label={uiText('assistant.project.new')} disabled={disabled} aria-expanded={creating} onClick={() => { setCollapsed(false); setCreating(!creating) }}><Plus /></button>
    </div>
    {!collapsed && projects.filter(project => !query.trim() || project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) || chats.some(chat => chat.projectId === project.id)).map(project => {
      const open = expanded[project.id] ?? projectId === project.id
      const projectChats = chats.filter(chat => chat.projectId === project.id)
      const all = showAll[project.id]
      return <div className="assistant-project-tree" key={project.id}>
        <div className="assistant-project-tree-row">
          <button className="assistant-project-tree-toggle" aria-expanded={open} onClick={() => setExpanded(current => ({ ...current, [project.id]: !open }))}>{open ? <FolderOpen /> : <Folder />}<span>{project.name}</span></button>
          <button className="assistant-iconbtn assistant-row-actions" title={uiText('assistant.sidebar.projectSettings')} aria-label={`${uiText('assistant.sidebar.projectSettings')}: ${project.name}`} onClick={() => openProjectSettings(project.id)}><LuSettings /></button>
          <button className="assistant-iconbtn assistant-row-actions" title={uiText('assistant.project.newChat')} aria-label={`${uiText('assistant.project.newChat')}: ${project.name}`} onClick={() => onNewChat(project.id)}><Compose /></button>
        </div>
        {open && <div className="assistant-project-tree-chats">{(all ? projectChats : projectChats.slice(0, 5)).map(chat => renderChat ? renderChat(chat) : <button className="assistant-thread-open" key={chat.id} onClick={() => onOpen(chat.id)}>{chat.title}</button>)}
          {!all && projectChats.length > 5 && <button className="assistant-show-more" onClick={() => setShowAll(current => ({ ...current, [project.id]: true }))}>{uiText('assistant.sidebar.showMore')}</button>}
        </div>}
      </div>
    })}
    {creating && <form className="assistant-project-create" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); setCreating(false); setName('') }
      if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); create() }
    }} onSubmit={event => { event.preventDefault(); create() }}>
      <input aria-label={uiText('assistant.project.name')} placeholder={uiText('assistant.project.name')} value={name} onChange={event => setName(event.target.value)} maxLength={256} autoFocus disabled={disabled} />
      <button type="button" className="assistant-btn" disabled={disabled || !name.trim()} onClick={create}>{uiText('assistant.project.create')}</button>
      <button type="button" className="assistant-iconbtn" aria-label={uiText('assistant.project.cancel')} disabled={pending} onClick={() => { setCreating(false); setName('') }}><X /></button>
    </form>}
    {error && <p className="assistant-project-error" role="alert">{error}</p>}
  </div>
}
