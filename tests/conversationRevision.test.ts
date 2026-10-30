import { afterEach, describe, expect, it, vi } from 'vitest'
import { register } from '../src/index'
import { getStore, disposeStore } from '../src/store'
import { sessionBackendFixture } from './sessionBackendFixture'

const fixtures: ReturnType<typeof sessionBackendFixture>[] = []
const disposers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const backend of fixtures.splice(0)) { await backend.cleanup(); await disposeStore(backend.api) }
  for (const dispose of disposers.splice(0)) await dispose()
})

describe('conversation settings revisions', () => {
  it('carries each saved revision into the next model and effort change', async () => {
    const backend = sessionBackendFixture(); fixtures.push(backend)
    disposers.push(register(backend.api))
    const store = getStore(backend.api); await store.whenReady
    let revision = 0
    const save = vi.spyOn(backend.api.assistant, 'saveChat').mockImplementation(async thread => {
      await Promise.resolve()
      if ((thread.configurationRevision ?? 0) !== revision) return { ok: false, error: 'Conversation settings changed; reload the Markdown note before updating them' }
      revision += 1
      return { ok: true, data: { configurationRevision: revision, configurationHash: `hash-${revision}`, instructionsPath: 'settings.md' } }
    })
    store.newChat()
    await store.saveThread({ ...store.getSnapshot().active!, messages: [{ role: 'user', content: 'Hello' }] })
    store.setModelOverride({ provider: 'anthropic', model: 'claude-opus-5-5' })
    store.setReasoningEffort(undefined)
    store.setModelOverride({ provider: 'anthropic', model: 'claude-sonnet-5-5' })
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(4))
    await vi.waitFor(() => expect(store.getSnapshot().active?.configurationRevision).toBe(4))
    expect(store.getSnapshot().error).toBeNull()
    expect(store.getSnapshot().active?.model).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' })
  })
})
