import { afterEach, describe, expect, it, vi } from 'vitest'
import { getStore, disposeStore } from '../src/store'
import { deferred, sessionBackendFixture } from './sessionBackendFixture'

const fixtures: ReturnType<typeof sessionBackendFixture>[] = []
afterEach(async () => { for (const backend of fixtures.splice(0)) { await backend.cleanup(); await disposeStore(backend.api) } })

describe('event-driven chat list reloads', () => {
  it('keeps one list read in flight during an event burst, and every caller sees a read made after its request', async () => {
    const backend = sessionBackendFixture(); fixtures.push(backend)
    let changed: ((value: unknown) => void) | undefined
    const on = backend.api.backend.on
    backend.api.backend.on = ((name: string, listener: (value: unknown) => void) => { if (name === 'conversations.changed') changed = listener; return on(name, listener) }) as typeof on
    const store = getStore(backend.api)
    await store.whenReady
    const list = backend.api.assistant.listChats, read = backend.api.assistant.readChat
    let inFlight = 0, most = 0, gate = deferred(), version = 0
    const listChats = vi.spyOn(backend.api.assistant, 'listChats').mockImplementation(async () => {
      inFlight++; most = Math.max(most, inFlight)
      const seen = ++version
      await gate.promise
      inFlight--
      const result = await list()
      return { ...result, data: { chats: [{ id: `list-${seen}`, title: `List ${seen}`, updatedAt: seen }] } } as Awaited<ReturnType<typeof list>>
    })
    const readChat = vi.spyOn(backend.api.assistant, 'readChat').mockImplementation(id => read(id))

    const first = store.reloadThreads()
    const burst = Array.from({ length: 300 }, () => store.reloadThreads())
    for (let index = 0; index < 300; index++) changed!({ id: 'chat-fern' })
    expect(listChats).toHaveBeenCalledOnce()
    gate.resolve(); gate = deferred(); gate.resolve()
    await Promise.all([first, ...burst])
    // One read for the first change and at most one more for the changes that arrived while it ran.
    await vi.waitFor(() => expect(readChat).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(store.getSnapshot().threads.map(thread => thread.id)).toEqual([`list-${version}`]))
    expect(most).toBe(1)
    expect(listChats.mock.calls.length).toBeLessThanOrEqual(3)
    expect(store.getSnapshot().error).toBeNull()
  })
})
