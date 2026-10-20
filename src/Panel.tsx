import { ChatView, formatSendTime } from './Page'
import { ProjectMode } from './ProjectMode'
import { React, api } from './runtime'
import type { FC } from 'react'
import type { AiChatSummary } from './types'
import { usePluginSetting, useAssistant, useChannels } from './hooks'
import { Chat, ChevronLeft, ChevronRight, Clock, Search, More, Pencil, Pin, Compose, Telegram, Trash, WhatsApp, X } from './icons'
import { LuSettings, RiVoiceAiFill } from './settingsIcons'
import { uiText } from './localization'
import { ConversationProperties } from './surfaces'
import { ErrorNotice } from './Preferences'

/**
 * Left-sidebar panel: a conversation list, a New-chat button, and a quick prompt
 * that opens the full chat page. Clicking a conversation opens it in the main
 * workspace tab.
 */
type SourceFilter = 'chat' | 'telegram' | 'whatsapp'

function useChatMenu(onRename: (id: string) => void): {
  openChatMenu: (e: React.MouseEvent, thread: AiChatSummary) => void
} {
  const { store } = useAssistant()

  const openChatMenu = (e: React.MouseEvent, thread: AiChatSummary): void => {
    e.preventDefault()
    e.stopPropagation()
    const point = { x: e.clientX, y: e.clientY }
    void api.ui.openMenu([
      { label: uiText('auto.d3f4cb898fbe'), icon: <Pencil className="" />, onSelect: () => onRename(thread.id) },
      {
        label: thread.pinned ? uiText('auto.2eba6a03b89a') : uiText('auto.9c918414710c'),
        icon: <Pin className="" />,
        onSelect: () => store.setPinned(thread.id, !thread.pinned)
      },
      { type: 'separator' },
      { label: uiText('auto.751e4570c26b'), icon: <X className="" />, onSelect: () => store.clearChat(thread.id) },
      {
        label: uiText('auto.f6fdbe48dc54'),
        icon: <Trash className="" />,
        danger: true,
        onSelect: () => api.ui.openMenu([
          { label: uiText('auto.77dfd2135f4d'), icon: <X /> },
          { label: uiText('auto.de434676e430'), icon: <Trash />, danger: true, onSelect: () => store.deleteChat(thread.id) }
        ], point)
      }
    ], point)
  }

  return { openChatMenu }
}

export function chatDateGroup(timestamp: number, now = new Date()): string {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(day); yesterday.setDate(day.getDate() - 1)
  const week = new Date(day); week.setDate(day.getDate() - 7)
  return timestamp >= day.getTime() ? 'today' : timestamp >= yesterday.getTime() ? 'yesterday' : timestamp >= week.getTime() ? 'week' : 'older'
}

function previewNodes(nodes: NodeListOf<ChildNode>): React.ReactNode[] {
  return Array.from(nodes).map((node, index) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent
    if (node.nodeType !== Node.ELEMENT_NODE) return null
    const element = node as Element
    const tag = element.tagName.toLowerCase()
    if (element.classList.contains('katex')) return <span key={index} className="assistant-thread-math" dangerouslySetInnerHTML={{ __html: element.outerHTML }} />
    if (['script', 'style', 'iframe', 'object', 'svg', 'input', 'button', 'video', 'audio'].includes(tag) || element.classList.contains('code-block-header')) return null
    if (tag === 'img') return element.getAttribute('alt') ?? ''
    if (tag === 'br') return ' '
    const children = previewNodes(element.childNodes)
    if (['strong', 'b', 'em', 'i', 'code', 's', 'del', 'sub', 'sup', 'mark'].includes(tag)) return React.createElement(tag, { key: index }, children)
    return <React.Fragment key={index}>{children}{['p', 'div', 'li', 'pre', 'blockquote', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag) ? ' ' : null}</React.Fragment>
  })
}

const ThreadPreview: FC<{ threadId: string; content: string; updatedAt: number }> = ({ threadId, content, updatedAt }) => {
  const [rendered, setRendered] = React.useState<{ source: string; nodes: React.ReactNode[] }>()
  React.useEffect(() => {
    let live = true
    void (async () => {
      const result = await api.assistant.readChat(threadId).catch(() => undefined)
      if (!live) return
      const message = result?.data?.thread?.messages.slice().reverse().find(message => ['user', 'assistant'].includes(message.role) && message.content.trim() && !message.toolCalls?.length)
      const html = await api.markdown.render(message?.displayContent || message?.content || content, { breaks: true })
      if (!live) return
      const template = document.createElement('template')
      template.innerHTML = html
      setRendered({ source: content, nodes: previewNodes(template.content.childNodes) })
    })().catch(() => { if (live) setRendered(undefined) })
    return () => { live = false }
  }, [threadId, content, updatedAt])
  return <span className="assistant-thread-preview">{rendered?.source === content ? rendered.nodes : content}</span>
}

const ThreadRow: FC<{ thread: AiChatSummary; busy?: boolean; unread?: boolean; errored?: boolean; preview: boolean; connected: boolean; showTime: boolean; project?: string; active: boolean; editing: boolean; onOpen(): void; onMenu(event: React.MouseEvent): void; onRename(value?: string): void }> = ({ thread, busy, unread, errored, preview, connected, showTime, project, active, editing, onOpen, onMenu, onRename }) => {
  const dateFormat = React.useSyncExternalStore(api.subscribe, () => api.getState().dateFormat)
  const timeFormat = React.useSyncExternalStore(api.subscribe, () => api.getState().timeFormat)
  const remote = thread.source === 'telegram' || thread.source === 'whatsapp'
  const lastChatted = showTime ? formatSendTime(thread.updatedAt, dateFormat, timeFormat) : null
  const [name, setName] = React.useState(thread.title)
  const inputRef = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => { if (editing) { setName(thread.title); inputRef.current?.select() } }, [editing, thread.title])
  return <div className={`assistant-thread-row${active ? ' active' : ''}${preview ? ' has-preview' : ''}${remote ? ' assistant-channel-row' : ''}`} onContextMenu={onMenu}>
    {editing ? <input ref={inputRef} autoFocus className="assistant-thread-rename" aria-label={uiText('auto.d3f4cb898fbe')} value={name} onChange={event => setName(event.target.value)} onBlur={() => onRename(name)} onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); onRename(name) }
      if (event.key === 'Escape') { event.preventDefault(); onRename() }
    }} /> : <button className="assistant-thread-open" aria-current={active ? 'page' : undefined} onClick={onOpen}>
      <span className="assistant-thread-line">{thread.pinned && <Pin />}<span className="assistant-thread-title">{thread.title}</span>{busy && <span className="assistant-thread-working" role="status" aria-label={uiText('assistant.activity.working')} title={uiText('assistant.activity.working')}><Clock /></span>}{!busy && (errored || unread) && <span className={`assistant-thread-dot${errored ? ' is-error' : ''}`} role="img" aria-label={uiText(errored ? 'assistant.sidebar.errored' : 'assistant.sidebar.unread')} title={uiText(errored ? 'assistant.sidebar.errored' : 'assistant.sidebar.unread')} />}{preview && project && <span className="assistant-thread-project">{project}</span>}{remote && lastChatted?.full && <time className="assistant-thread-time" dateTime={new Date(thread.updatedAt).toISOString()} title={lastChatted.full}>{lastChatted.full}</time>}</span>
      {preview && thread.preview && <ThreadPreview threadId={thread.id} content={thread.preview} updatedAt={thread.updatedAt} />}
      <span className={remote ? 'assistant-channel-meta' : undefined}>
        {remote && <span className="assistant-channel-identity" title={thread.channelIdentity || thread.title}>{connected && <span className="assistant-connection-dot" role="img" aria-label={uiText('assistant.channel.connected')} title={uiText('assistant.channel.connected')} />}<span>{thread.channelIdentity || thread.title}</span></span>}
        {!remote && lastChatted?.label && <time className="assistant-thread-time" dateTime={new Date(thread.updatedAt).toISOString()} title={lastChatted.full}>{lastChatted.label}</time>}
      </span>
    </button>}
    {!editing && <button className="assistant-iconbtn assistant-row-actions" title={uiText('assistant.sidebar.chatActions')} aria-label={`${uiText('assistant.sidebar.chatActions')}: ${thread.title}`} onClick={onMenu}><More /></button>}
  </div>
}

export const Panel: FC<{ navigation?: { source: SourceFilter; onSourceChange(source: SourceFilter): void; onOpen(): void } }> = ({ navigation }) => {
  const { store, snap } = useAssistant()
  const [localFilter, setLocalFilter] = React.useState<SourceFilter>('chat')
  const filter = navigation?.source ?? localFilter
  const setFilter = navigation?.onSourceChange ?? setLocalFilter
  const [error, setError] = React.useState('')
  const channelView = filter === 'telegram' || filter === 'whatsapp'
  const { channels } = useChannels()
  const [renamingId, setRenamingId] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState('')
  React.useEffect(() => { setQuery(''); setError('') }, [filter])
  const [activeInProjects, setActiveInProjects] = React.useState(false)
  const [recentsExpanded, setRecentsExpanded] = React.useState(true)
  const [projects, setProjects] = React.useState<import('./types').AssistantProject[]>([])
  const chronologicalKey = filter === 'chat' ? 'sidebarChronological' : `${filter}Chronological`
  const chronological = usePluginSetting(chronologicalKey, false)
  const showTelegram = usePluginSetting('showTelegram', true)
  const showWhatsApp = usePluginSetting('showWhatsApp', true)
  const { openChatMenu } = useChatMenu(setRenamingId)
  React.useEffect(() => {
    if (filter === 'telegram' && !showTelegram || filter === 'whatsapp' && !showWhatsApp) setFilter('chat')
  }, [filter, showTelegram, showWhatsApp])
  const openChat = async (id: string): Promise<void> => {
    setError('')
    try {
      if (!await store.openChat(id)) { setError(uiText('assistant.surface.missing')); return }
      if (navigation) navigation.onOpen()
      else api.workspace.openMainTab()
    } catch (error) { setError(String(error)) }
  }
  const newChat = async (projectId?: string): Promise<void> => {
    store.newChat(projectId)
    if (navigation) navigation.onOpen()
    else api.workspace.openMainTab()
  }
  const visible = snap.threads.filter(thread => {
    if (thread.source === 'telegram' && !showTelegram || thread.source === 'whatsapp' && !showWhatsApp) return false
    if ((thread.source ?? 'chat') !== filter) return false
    const project = projects.find(project => project.id === thread.projectId)
    return !query.trim() || `${thread.title} ${thread.channelIdentity ?? ''} ${thread.preview ?? ''} ${project?.name ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  }).sort((a, b) => (chronological ? 0 : Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))) || b.updatedAt - a.updatedAt)
  const row = (thread: AiChatSummary, inProject = false): React.ReactNode => <ThreadRow key={thread.id} thread={thread} busy={snap.busyChatIds?.includes(thread.id)} unread={snap.unreadChatIds?.includes(thread.id)} errored={snap.erroredChatIds?.includes(thread.id)} preview={chronological} showTime={channelView || chronological} connected={channels.some(channel => channel.id === thread.channelId && channel.connected && channel.running && !channel.error)} project={projects.find(project => project.id === thread.projectId)?.name}
    active={snap.active?.id === thread.id && (chronological || channelView || inProject || !activeInProjects)} editing={renamingId === thread.id} onOpen={() => void openChat(thread.id)} onMenu={event => openChatMenu(event, thread)} onRename={name => {
      if (name?.trim() && name.trim() !== thread.title) void store.renameChat(thread.id, name.trim())
      setRenamingId(null)
    }} />
  return <div className="assistant-panel" aria-busy={!snap.ready}>
    {!navigation && <div className="panel-header assistant-panel-head">
      <span className="panel-title">{uiText('assistant.project.chat')}</span>
      <div className="assistant-source-filters">
        {([...(showTelegram ? ['telegram'] : []), ...(showWhatsApp ? ['whatsapp'] : []), 'chat'] as SourceFilter[]).map(source => <button key={source} className="assistant-iconbtn" title={uiText(`assistant.sidebar.source.${source}`)} aria-label={uiText(`assistant.sidebar.source.${source}`)} aria-pressed={filter === source} onClick={() => { setFilter(source); setQuery('') }}>{source === 'telegram' ? <Telegram /> : source === 'whatsapp' ? <WhatsApp /> : <Chat />}</button>)}
        <button className="assistant-iconbtn" title={uiText('assistant.voice.start')} aria-label={uiText('assistant.voice.start')} aria-pressed={snap.voiceConversationId === snap.active?.id && Boolean(snap.voiceConversationId)} onClick={() => { setFilter('chat'); setQuery(''); store.openVoice() }}><RiVoiceAiFill /></button>
        <button className="assistant-iconbtn" title={uiText('assistant.sidebar.time')} aria-label={uiText('assistant.sidebar.time')} aria-pressed={chronological} onClick={() => void api.settings.set(chronologicalKey, !chronological)}><Clock /></button>
      </div>
    </div>}
    <div className="assistant-sidebar-toolbar search-field-row">
      <div className="search-field">
        <Search className="search-field-icon" />
        <input className="search-field-input" placeholder={uiText('assistant.sidebar.search')} aria-label={uiText('assistant.sidebar.search')} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setQuery('') }} />
      </div>
      {channelView ? <button className="assistant-iconbtn" title={uiText('assistant.channel.settings')} aria-label={uiText('assistant.channel.settings')} onClick={() => api.workspace.openSettings(`plugin:assistant#${filter}`)}><LuSettings /></button> : <button className="assistant-iconbtn" title={uiText('auto.009bf6b90cde')} aria-label={uiText('auto.009bf6b90cde')} onClick={() => void newChat()}><Compose /></button>}
    </div>
    <div className={`assistant-sidebar-scroll${channelView ? ' assistant-channel-scroll' : ''}`}>
      {error && <ErrorNotice error={error} />}
      {!channelView && <div hidden={chronological}>
        <ProjectMode projectId={snap.active?.projectId} chats={visible} busy={false} onSelect={newChat} onNewChat={id => { void newChat(id) }} onOpen={openChat}
          renderChat={thread => row(thread, true)} activeChatId={snap.active?.id} onActiveChatVisibleChange={setActiveInProjects} query={query} onProjectsChange={setProjects} />
      </div>}
      {chronological ? ['today', 'yesterday', 'week', 'older'].map(group => {
        const threads = visible.filter(thread => chatDateGroup(thread.updatedAt) === group)
        return threads.length ? <section key={group} className="assistant-chat-section"><h3>{uiText(`assistant.sidebar.${group}`)}</h3>{threads.map(thread => row(thread))}</section> : null
      }) : channelView ? <section className="assistant-chat-section">{visible.map(thread => row(thread))}</section> : <section className="assistant-chat-section"><h3><button className="assistant-section-toggle" aria-expanded={recentsExpanded} onClick={() => setRecentsExpanded(!recentsExpanded)}>{uiText('assistant.sidebar.recents')}<ChevronRight className={recentsExpanded ? 'is-expanded' : ''} /></button><button className="assistant-iconbtn" aria-label={uiText('auto.009bf6b90cde')} title={uiText('auto.009bf6b90cde')} onClick={() => void newChat()}><Compose /></button></h3>{recentsExpanded && visible.map(thread => row(thread))}</section>}
      {!visible.length && <div className="assistant-empty assistant-sidebar-empty">{uiText(query ? 'assistant.sidebar.noResults' : 'auto.265928933f22')}</div>}
    </div>
  </div>
}

export const SidebarPage: FC = () => {
  const { store, snap } = useAssistant()
  const [screen, setScreen] = React.useState<'chat' | 'list' | 'details'>('chat')
  const [source, setSource] = React.useState<SourceFilter>(snap.active?.source ?? 'chat')
  const showTelegram = usePluginSetting('showTelegram', true)
  const showWhatsApp = usePluginSetting('showWhatsApp', true)
  const chronologicalKey = source === 'chat' ? 'sidebarChronological' : `${source}Chronological`
  const chronological = usePluginSetting(chronologicalKey, false)
  React.useEffect(() => { if (screen !== 'list') setSource(snap.active?.source ?? 'chat') }, [screen, snap.active?.id, snap.active?.source])
  React.useEffect(() => {
    if (source === 'telegram' && !showTelegram || source === 'whatsapp' && !showWhatsApp) { setSource('chat'); setScreen('list') }
  }, [source, showTelegram, showWhatsApp])
  const openVoice = (): void => { store.openVoice(false); setScreen('chat') }
  return <div className="assistant-mobile">
    <div className="panel-header assistant-panel-head assistant-mobile-head">
      <span className="panel-title">{uiText('assistant.project.chat')}</span>
      <div className="assistant-source-filters">
        <nav className="assistant-mobile-sources" aria-label={uiText('assistant.mobile.sources')}>
          {([...(showTelegram ? ['telegram'] : []), ...(showWhatsApp ? ['whatsapp'] : []), 'chat'] as SourceFilter[]).map(value => <button key={value} type="button" className="assistant-iconbtn" title={uiText(`assistant.sidebar.source.${value}`)} aria-label={uiText(`assistant.sidebar.source.${value}`)} aria-pressed={source === value} onClick={() => { setSource(value); setScreen('list') }}>
            {value === 'telegram' ? <Telegram /> : value === 'whatsapp' ? <WhatsApp /> : <Chat />}
          </button>)}
        </nav>
        <button className="assistant-iconbtn" title={uiText('assistant.voice.start')} aria-label={uiText('assistant.voice.start')} aria-pressed={snap.voiceConversationId === snap.active?.id && Boolean(snap.voiceConversationId)} onClick={openVoice}><RiVoiceAiFill /></button>
        {screen === 'list' && <>
          <button className="assistant-iconbtn" title={uiText('assistant.sidebar.time')} aria-label={uiText('assistant.sidebar.time')} aria-pressed={chronological} onClick={() => void api.settings.set(chronologicalKey, !chronological)}><Clock /></button>
          {snap.active && <button className="assistant-iconbtn" aria-label={uiText('assistant.mobile.resume')} title={uiText('assistant.mobile.resume')} onClick={() => setScreen('chat')}><ChevronRight /></button>}
        </>}
      </div>
    </div>
    <div className="assistant-mobile-content">
      <div className="assistant-mobile-list" hidden={screen !== 'list'}>
        <Panel navigation={{ source, onSourceChange: setSource, onOpen: () => setScreen('chat') }} />
      </div>
      {screen === 'chat' && <ChatView sidebar={{ onBack: () => setScreen('list'), onProperties: () => setScreen('details') }} />}
      {screen === 'details' && <div className="assistant-mobile-details">
        <div className="assistant-mobile-details-head"><button className="assistant-iconbtn" aria-label={uiText('assistant.mobile.resume')} title={uiText('assistant.mobile.resume')} onClick={() => setScreen('chat')}><ChevronLeft /></button><span>{uiText('assistant.mobile.settings')}</span></div>
        <div className="assistant-mobile-details-body" data-plugin-widget-layout="fill"><api.ui.ScrollPanel fill><ConversationProperties /></api.ui.ScrollPanel></div>
      </div>}
    </div>
  </div>
}
