import type { ValleyPluginApi } from './api'
import { METADATA_PANEL_SEGMENT_V1, WORKSPACE_DETAILS_V1, provideBookmarkSurface, type PluginInspectionSubject } from '@valley/plugin-sdk'
import type { AiPersonality } from './types'
import { api, React } from './runtime'
import { useAssistant } from './hooks'
import { getStore, type AssistantSnapshot } from './store'
import { readConversation } from './commands'
import { ChatDetail } from './Settings'
import { uiText } from './localization'
import type { InteropValueSchema } from '@valley/plugin-sdk'

const bookmarkStateSchema = {
  "type": "object",
  "properties": {
    "chatId": {
      "type": "string"
    }
  },
  "required": [],
  "additionalProperties": false
} satisfies InteropValueSchema



export function ConversationProperties({ subject }: { subject?: PluginInspectionSubject }): React.ReactElement {
  const { snap, store } = useAssistant()
  const [personalities, setPersonalities] = React.useState<AiPersonality[]>([])
  React.useEffect(() => { let live = true; void api.assistant.listPersonalities().then((result) => { if (live) setPersonalities(result.data?.personalities ?? []) }); return () => { live = false } }, [])
  const id = subject?.item?.id ?? snap.active?.id
  const summary = snap.threads.find((thread) => thread.id === id) ?? (snap.active?.id === id ? snap.active : undefined)
  if (!id) return <div className="right-panel-body props-info"><dl className="props-info-table"><div className="props-info-row"><dt className="props-info-key">{uiText('assistant.surface.conversations')}</dt><dd className="props-info-value">{snap.threads.length}</dd></div></dl></div>
  if (!summary) return <div className="right-panel-body" role="alert">{uiText('assistant.surface.missing')}</div>
  return <div className="right-panel-body assistant-properties"><ChatDetail key={id} summary={summary} personalities={personalities} connections={snap.config?.connections ?? []} embedded backTo="" onBack={() => {}} onChanged={() => store.reloadThreads()} /></div>
}

function footerStatus(snap: AssistantSnapshot): string {
  if (snap.error || snap.sessionState === 'FAILED') return 'error'
  if (snap.stopped) return 'stopped'
  if (snap.pending || snap.sessionState === 'AWAITING_APPROVAL') return 'approval'
  if (snap.sessionState === 'AWAITING_QUESTION' || !snap.activeBusy && snap.active?.plan?.status === 'review') return 'input'
  if (snap.sessionState === 'QUEUED') return 'queued'
  if (snap.sessionState === 'PREPARING') return 'preparing'
  if (snap.sessionState === 'COMPACTING') return 'compacting'
  if (snap.activeBusy) {
    if (snap.phase === 'working' || snap.sessionState === 'AWAITING_TOOLS') return 'working'
    return snap.streamingText ? 'writing' : 'thinking'
  }
  if (snap.queuePaused && snap.active?.pendingMessages?.length) return 'paused'
  const last = [...(snap.active?.messages ?? [])].reverse().find(message => message.role === 'user' || message.role === 'assistant')
  return last?.error ? 'error' : last?.role === 'assistant' && !last.toolCalls?.length && last.content.trim() ? 'finished' : 'ready'
}

export function registerAssistantSurfaces(pluginApi: ValleyPluginApi): () => void {
  const store = getStore(pluginApi)
  const surfaces = ['main_workspace', 'left_sidebar', 'right_sidebar'] as const
  const offs = surfaces.map((surface) => provideBookmarkSurface(pluginApi, {
    id: `assistant.${surface}`, surface, subscribe: store.subscribe,
    getSnapshot: () => {
      const snap = store.getSnapshot()
      const selected = snap.active
      return { title: selected?.title || uiText('manifest.name'), view: {},
        ...(selected ? { item: { id: selected.id, title: selected.title, state: { chatId: selected.id } } } : {}),
        navigation: { canGoBack: snap.canGoBack, canGoForward: snap.canGoForward, goBack: () => store.goBack(), goForward: () => store.goForward() }
      }
    },
    restore: async (state, _instanceId, context) => {
      await store.whenReady
      if (state.chatId === undefined || (context?.background && surface !== 'main_workspace')) return
      if (context?.background && store.hasUserSelection) return
      if (typeof state.chatId !== 'string' || !state.chatId) throw new Error('Invalid conversation bookmark. Choose another conversation.')
      await readConversation(pluginApi, state.chatId)
      await store.openChat(state.chatId)
    }
  }, { stateSchema: bookmarkStateSchema, itemStateSchema: { ...bookmarkStateSchema, required: [...bookmarkStateSchema.required, "chatId"] }, description: (snapshot, item) => typeof snapshot.view.path === 'string' && snapshot.view.path ? snapshot.view.path : uiText(item ? 'bookmark.item' : 'bookmark.view') }))
  offs.push(pluginApi.interop.extensions.provide(WORKSPACE_DETAILS_V1, {
    id: 'assistant.details', label: 'Assistant', labelKey: 'manifest.name', pluginViews: true,
    items: ['title', 'status', 'model', 'messages', 'queued', 'running', 'access', 'source'].map(id => ({ id, label: uiText(`assistant.footer.${id}`), labelKey: `assistant.footer.${id}`, kind: 'text' as const })),
    defaultItems: ['title', 'status'], subscribe: store.subscribe,
    getSnapshot: () => {
      const snap = store.getSnapshot(), chat = snap.active
      const model = chat?.model
      const connection = snap.config?.connections.find(value => value.id === model?.connectionId)
      const modelLabel = model ? connection?.models.find(value => value.id === model.model)?.label || model.model : uiText('assistant.footer.auto')
      const messages = chat?.messages.filter(message => ['user', 'assistant'].includes(message.role) && !message.toolCalls?.length && !message.error && message.content.trim()).length ?? 0
      return { items: {
        title: { text: chat?.title || uiText('manifest.name') },
        status: { text: uiText(`assistant.footer.state.${footerStatus(snap)}`) },
        model: { text: modelLabel },
        messages: { text: `${uiText('assistant.footer.messages')}: ${messages}` },
        queued: { text: `${uiText('assistant.footer.queued')}: ${chat?.pendingMessages?.length ?? 0}` },
        running: { text: `${uiText('assistant.footer.running')}: ${snap.runningChatCount ?? 0}` },
        access: { text: uiText(snap.dangerous?.enabled ? 'assistant.permissions.full' : 'assistant.permissions.vault') },
        source: { text: chat?.source === 'telegram' ? 'Telegram' : chat?.source === 'whatsapp' ? 'WhatsApp' : uiText('plugin.assistant.section.chat') }
      } }
    }
  }))
  offs.push(pluginApi.interop.extensions.provide(METADATA_PANEL_SEGMENT_V1, {
    id: 'assistant.properties', label: 'Conversation', labelKey: 'assistant.surface.conversation', icon: 'chat', pluginSurfaces: ['main_workspace'], editCommand: 'update-properties',
    inspect: async ({ subject }) => {
      if (!subject?.item) return [{ id: 'count', label: uiText('assistant.surface.conversations'), value: store.getSnapshot().threads.length, readOnly: true }]
      const thread = await readConversation(pluginApi, subject.item.id)
      return [
        { id: 'title', label: uiText('assistant.surface.title'), value: thread.title, type: 'text' },
        { id: 'pinned', label: uiText('assistant.surface.pinned'), value: thread.pinned === true, type: 'boolean' },
        { id: 'model', label: uiText('auto.6dcf16e1c5d3'), value: thread.model ? { ...thread.model } : null, type: 'json' },
        { id: 'profileId', label: uiText('auto.ed58f29743f8'), value: thread.profileId ?? '', type: 'text' },
        { id: 'attachmentParser', label: uiText('auto.909447ccca66'), value: thread.attachmentParser ?? '', type: 'text' },
        { id: 'commands', label: uiText('auto.633cad38d705'), value: (thread.commands ?? []).map((command) => ({ ...command })), type: 'json' }
      ]
    },
    render: ({ subject }) => <ConversationProperties subject={subject} />
  }))
  return () => { offs.forEach((off) => off()) }
}
