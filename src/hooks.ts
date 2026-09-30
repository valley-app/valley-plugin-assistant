import { React, api } from './runtime'
import { getStore } from './store'
import type { ChannelInfo } from './types'
import type { AssistantSnapshot } from './store'

/** Subscribe a view to the window-anchored assistant store. */
export function useAssistant(): { store: ReturnType<typeof getStore>; snap: AssistantSnapshot } {
  const store = getStore(api)
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  return { store, snap }
}

/**
 * One of this plugin's persisted settings, live.
 *
 * `api.settings.get()` builds a fresh object on every call, so the settings
 * record itself can never be a `useSyncExternalStore` snapshot — the store would
 * report a change on every render. Reading a single **primitive** out of it makes
 * the snapshot compare by value, which is stable.
 */
export function usePluginSetting<T extends string | boolean | number>(key: string, fallback: T): T {
  const read = React.useCallback((): T => {
    const value = api.settings.get()[key]
    return typeof value === typeof fallback ? (value as T) : fallback
  }, [key, fallback])
  return React.useSyncExternalStore(api.settings.subscribe, read)
}

export function useChannels(): { channels: ChannelInfo[]; error: string } {
  const [state, setState] = React.useState<{ channels: ChannelInfo[]; error: string }>({ channels: [], error: '' })
  React.useEffect(() => {
    let live = true
    let revision = 0
    const refresh = async (): Promise<void> => {
      const request = ++revision
      try {
        const result = await api.channels.list()
        if (live && request === revision) setState({ channels: result.ok ? result.data?.channels ?? [] : [], error: result.ok ? '' : result.error ?? '' })
      } catch (error) {
        if (live && request === revision) setState({ channels: [], error: String(error) })
      }
    }
    const off = api.backend.on('channels.changed', () => { void refresh() })
    void refresh()
    return () => { live = false; off() }
  }, [])
  return state
}
