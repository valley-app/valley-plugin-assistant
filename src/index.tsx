import { createAssistantApi, disposeAssistantConfiguration } from './api'
import type { ValleyPluginApi as HostApi } from '@valley/plugin-sdk'
/**
 * Valley Assistant — a multi-provider, agentic AI chat that can both answer and
 * act inside the app through its own host APIs and provider-owned tools. It is
 * conducted by the user via the
 * `.valley/assistant/` config ("Mother of the orchestra") and reachable over
 * remote channels (Telegram and WhatsApp via the same adapter layer).
 *
 * Three views: `assistant.panel` (left_sidebar conversation list), `assistant.page`
 * (main_workspace full chat) and `assistant.settings` (Settings → Assistant).
 */
import { SEARCH_RESULT_ACTION_V1, type ValleyPluginModule } from '@valley/plugin-sdk'
import { initRuntime, api as runtimeApi, React } from './runtime'
import { injectStyles } from './styles'
import { getStore, disposeStore } from './store'
import { route } from './router'
import { streamOnce } from './agent/loop'
import { Panel, SidebarPage } from './Panel'
import { Page } from './Page'
import { Settings } from './Settings'
import { initLocalization } from './localization'
import { registerAssistantCommands } from './commands'
import { registerAssistantSurfaces } from './surfaces'

export function register(hostApi: HostApi): () => Promise<void> {
  const api = createAssistantApi(hostApi)
  initLocalization(api)
  initRuntime(api)
  const disposeStyles = injectStyles()
  // Instantiate the session-scoped engine eagerly so channels auto-start and
  // config/threads load before any view mounts.
  const store = getStore(api)
  const offBeforeUnload = api.runtime.onBeforeUnload(() => store.prepareUnload(), () => store.resumeAfterUnloadCancellation())
  const offCommands = registerAssistantCommands(api)
  const offSurfaces = registerAssistantSurfaces(api)
  const offSearch = api.interop.extensions.provide(SEARCH_RESULT_ACTION_V1, {
    cardKind: 'assistant-chat',
    open: async (record, context) => {
      if (typeof record.id !== 'string' || !record.id) return false
      await store.whenReady
      if (!await store.openChat(record.id)) return false
      api.workspace.openMainTab({ newTab: context.newTab })
      return true
    }
  })
  let disposal: Promise<void> | undefined

  api.registerView('assistant.panel', Panel)
  api.registerView('assistant.page', Page)
  api.registerView('assistant.sidebar', SidebarPage)
  api.registerView('assistant.settings', Settings)

  const offOpen = api.commands.register({
    id: 'open',
    label: 'Assistant: Open chat', labelKey: 'auto.61d90e3d9930',
    hotkey: 'Mod-Shift-a',
    sideEffect: 'read',
    run: () => {
      api.workspace.openMainTab()
      return undefined
    }
  })
  const offNew = api.commands.register({
    id: 'new-chat',
    label: 'Assistant: New chat', labelKey: 'auto.2dacd6a705d1',
    sideEffect: 'read',
    run: () => {
      getStore(api).newChat()
      api.workspace.openMainTab()
      return undefined
    }
  })

  // Terminal: `valley assistant ask "…"` — a headless one-shot (no tools).
  const offAsk = api.commands.register({
    id: 'ask',
    label: 'Assistant: Ask a question (one-shot, no tools)', labelKey: 'auto.d17275e8a878',
    paletteSafe: false,
    sideEffect: 'read',
    usage: 'assistant ask "your question"',
    input: {
      schema: { type: 'object', properties: { question: { type: 'string', minLength: 1 } }, required: ['question'], additionalProperties: false },
      parse: (raw) => {
        const question = typeof (raw as { question?: unknown } | undefined)?.question === 'string'
          ? (raw as { question: string }).question.trim()
          : ''
        if (!question) throw new Error('Usage: valley assistant ask "your question"')
        return { question }
      },
      fromCli: (args) => ({ question: args.join(' ').trim() })
    },
    run: async ({ question }) => {
      const cfgRes = await runtimeApi.assistant.getConfig()
      const config = cfgRes.data
      if (!config) throw new Error('Assistant config unavailable')
      const routed = route({ text: question }, config.routing)
      const requestId = `cli-${Date.now().toString(36)}`
      const result = await streamOnce(
        api,
        {
          requestId,
          provider: routed.provider,
          model: routed.model,
          messages: [
            { role: 'system', content: config.instructions },
            { role: 'user', content: question }
          ],
          maxTokens: 4096
        },
        () => {}
      )
      if (result.error) throw new Error(result.error)
      return result.text || '(no response)'
    },
    formatCli: (text) => text
  })

  return () => {
    if (disposal) return disposal
    offOpen()
    offNew()
    offAsk()
    offCommands()
    offSurfaces()
    offSearch()
    offBeforeUnload()
    disposeAssistantConfiguration(api)
    const drained = disposeStore(api, store)
    disposeStyles()
    return disposal = drained
  }
}

const plugin: ValleyPluginModule = { register }
export default plugin
