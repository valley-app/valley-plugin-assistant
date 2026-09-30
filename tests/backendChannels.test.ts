import './backendFileFixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'



import { createTelegramChannel, isAllowed, nextBackoff, parseUpdates } from '../src/backend/channels/telegram'
import { channelManager } from '../src/backend/channels/manager'
import { channelKey, channelSecretKey, setSecret } from '../src/backend/secrets'
import { DEFAULT_WHATSAPP_GRAPH_VERSION, DEFAULT_WHATSAPP_WEBHOOK_PORT } from '../src/backend/channels/whatsapp'
import type { MessagingChannel } from '../src/backend/channels/types'
import { writeChannelConfigurations } from '../src/backend/configuration/channels'
import { AssistantRepository, record } from '../src/backend/persistence/repositories'
import { datasetFixture } from './backendDatasetFixture'

describe('telegram adapter (pure)', () => {
  it('parseUpdates extracts text messages and the next offset', () => {
    const { messages, nextOffset } = parseUpdates({
      ok: true,
      result: [
        { update_id: 10, message: { text: 'hi', chat: { id: 123 }, from: { username: 'fern' } } },
        { update_id: 11, message: { chat: { id: 5 } } } // no text → ignored
      ]
    })
    expect(messages).toMatchObject([{ providerEventId: '10', chatRef: '123', chatId: '123', from: 'fern', text: 'hi' }])
    expect(nextOffset).toBe(12)
  })

  it('isAllowed rejects an empty allow-list and matches ids', () => {
    expect(isAllowed('123', [])).toBe(false)
    expect(isAllowed('123', ['123', '456'])).toBe(true)
    expect(isAllowed('999', ['123'])).toBe(false)
  })

  it('parseUpdates turns a callback_query (button tap) into a data-carrying message + ack id', () => {
    const { messages, callbackIds, nextOffset } = parseUpdates({
      ok: true,
      result: [
        {
          update_id: 20,
          callback_query: { id: 'cb1', data: 'yes', from: { username: 'fern' }, message: { chat: { id: 123 } } }
        }
      ]
    })
    expect(messages).toMatchObject([{ providerEventId: '20', callbackQueryId: 'cb1', chatRef: '123', chatId: '123', from: 'fern', text: '', data: 'yes' }])
    expect(callbackIds).toEqual(['cb1'])
    expect(nextOffset).toBe(21)
  })
})

describe('channel manager (multi-instance, pluggable)', () => {
  let root: string
  const sent: { token: string; chatRef: string; text: string }[] = []

  // A second adapter *type* registers cleanly beside Telegram; the manager
  // instantiates one channel per configured connection.
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'assistant-chan-'))
    sent.length = 0
    channelManager.registerFactory('fake', (id, name) => {
      const ch: MessagingChannel = {
        id,
        type: 'fake',
        displayName: name,
        running: false,
        start() {
          ch.running = true
        },
        stop() {
          ch.running = false
        },
        async send(token, chatRef, text) {
          sent.push({ token, chatRef, text })
        }
      }
      return ch
    }, ['api.telegram.org'])
  })
  afterEach(async () => {
    await channelManager.stopAll()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('reports current configured account and recipient availability rather than adapter presence', async () => {
    const config = { bot: { type: 'telegram', name: 'Field bot', allowFrom: ['123'], enabled: false } }
    const destination = { kind: 'telegram' as const, conversationId: 'chat', channelId: 'bot', chatRef: '123' }
    await writeChannelConfigurations(root, config)
    expect(await channelManager.operationDescriptors(root, destination)).toMatchObject({ available: false, reason: 'Channel connection is disabled' })
    config.bot.enabled = true; await writeChannelConfigurations(root, config)
    expect(await channelManager.operationDescriptors(root, destination)).toMatchObject({ available: false, reason: 'Channel credential is missing or unreadable' })
    await setSecret(root, channelKey('bot'), 'TOKEN', [{ host: 'api.telegram.org', port: 443, security: 'tls' }])
    const result = await channelManager.operationDescriptors(root, destination)
    expect(result).toMatchObject({ available: true, transport: 'cloud-bot-api', inboundDownloadMaxBytes: 20 * 1024 * 1024 })
    expect(result.media.file).toMatchObject({ maxBytes: 50 * 1024 * 1024, effectiveMaxBytes: 32 * 1024 * 1024 })
    expect(result.operations.find(operation => operation.type === 'pin')).toMatchObject({ available: true, requirement: expect.stringContaining('administrator') })
    expect(await channelManager.operationDescriptors(root, { ...destination, chatRef: 'other' })).toMatchObject({ available: false, reason: 'Recipient is not allowed for this connection' })
  })

  it('reports the WhatsApp support window from durable receipts and retains templates when closed', async () => {
    await writeChannelConfigurations(root, { wa: { type: 'whatsapp', name: 'Field phone', allowFrom: ['123'], enabled: true, phoneNumberId: 'phone' } })
    await setSecret(root, channelKey('wa'), 'TOKEN', [{ host: 'graph.facebook.com', port: 443, security: 'tls' }])
    const repository = new AssistantRepository(datasetFixture())
    channelManager.bindRuntime({ repository, onInbound: async () => {}, onLifecycle: async () => {} })
    const destination = { kind: 'whatsapp' as const, conversationId: 'chat', channelId: 'wa', chatRef: '123' }
    const before = await channelManager.operationDescriptors(root, destination)
    expect(before.operations.find(operation => operation.type === 'text')).toMatchObject({ available: false, reason: expect.stringContaining('support window is closed') })
    expect(before.operations.find(operation => operation.type === 'template')).toMatchObject({ available: true })
    await repository.data.transaction([{ dataset: 'inbound_receipts', operation: 'insert', values: record('incoming', 'chat', 'ACCEPTED', { receivedAt: Date.now() }) }])
    expect((await channelManager.operationDescriptors(root, destination)).operations.find(operation => operation.type === 'text')).toMatchObject({ available: true })
  })

  it('does not restart a channel whose pending credentials complete after stopAll', async () => {
    const id = await channelManager.add(root, 'fake', 'Forest')
    await setSecret(root, channelKey(id), 'TOK', [{ host: 'api.telegram.org', port: 443, security: 'tls' }])
    await channelManager.start(root, id)
    await channelManager.stopAll()
    let finish!: (value: string) => void
    const credential = vi.spyOn(channelManager, 'credential').mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve }))
    const starting = channelManager.ensureStarted(root)
    try {
      await vi.waitFor(() => expect(credential).toHaveBeenCalledOnce())
      await channelManager.stopAll()
      finish('opaque-old')
      await starting
      const instances = (channelManager as unknown as { instances: Map<string, MessagingChannel> }).instances
      expect(instances.get(id)?.running).toBe(false)
    } finally { credential.mockRestore(); finish?.('opaque-old'); await starting }
  })

  it('adds, names, starts/stops, routes sends, and removes an instance', async () => {
    const id = await channelManager.add(root, 'fake', 'My Fake')
    let info = (await channelManager.list(root)).find((c) => c.id === id)
    expect(info?.name).toBe('My Fake')
    expect(info?.type).toBe('fake')
    expect(info?.configured).toBe(false)

    await setSecret(root, channelKey(id), 'TOK', [{ host: 'api.telegram.org', port: 443, security: 'tls' }])
    await channelManager.rename(root, id, 'Renamed')
    await channelManager.start(root, id)
    info = (await channelManager.list(root)).find((c) => c.id === id)
    expect(info?.running).toBe(true)
    expect(info?.name).toBe('Renamed')

    await channelManager.send(root, id, 'chat1', 'hello')
    expect(sent).toContainEqual({ token: `opaque:${channelKey(id)}`, chatRef: 'chat1', text: 'hello' })

    await channelManager.stop(root, id)
    expect((await channelManager.list(root)).find((c) => c.id === id)?.running).toBe(false)

    await channelManager.remove(root, id)
    expect((await channelManager.list(root)).find((c) => c.id === id)).toBeUndefined()
  })

  it('sendButtons uses the adapter when supported, else falls back to a text prompt', async () => {
    const buttoned: { chatRef: string; text: string; buttons: { label: string; value: string }[] }[] = []
    channelManager.registerFactory('fakebtn', (id, name) => {
      const ch: MessagingChannel = {
        id,
        type: 'fakebtn',
        displayName: name,
        running: false,
        start() {
          ch.running = true
        },
        stop() {
          ch.running = false
        },
        async send(token, chatRef, text) {
          sent.push({ token, chatRef, text })
        },
        async sendButtons(_token, chatRef, text, buttons) {
          buttoned.push({ chatRef, text, buttons })
        }
      }
      return ch
    }, ['api.telegram.org'])

    // Button-capable adapter: gets the structured buttons.
    const withBtn = await channelManager.add(root, 'fakebtn', 'WithButtons')
    await setSecret(root, channelKey(withBtn), 'TOK', [{ host: 'api.telegram.org', port: 443, security: 'tls' }])
    await channelManager.sendButtons(root, withBtn, 'chatA', 'Confirm?', [
      { label: '✅ Allow', value: 'yes' },
      { label: '✋ Skip', value: 'no' }
    ])
    expect(buttoned).toHaveLength(1)
    expect(buttoned[0].buttons.map((b) => b.value)).toEqual(['yes', 'no'])

    // Adapter without sendButtons: falls back to a plain message listing choices.
    const noBtn = await channelManager.add(root, 'fake', 'NoButtons')
    await setSecret(root, channelKey(noBtn), 'TOK', [{ host: 'api.telegram.org', port: 443, security: 'tls' }])
    await channelManager.sendButtons(root, noBtn, 'chatB', 'Confirm?', [
      { label: '✅ Allow', value: 'yes' },
      { label: '✋ Skip', value: 'no' }
    ])
    expect(sent.find((s) => s.chatRef === 'chatB')?.text).toContain('"yes"')
  })

  it('supports multiple named connections of the same type', async () => {
    const a = await channelManager.add(root, 'fake', 'Alpha')
    const b = await channelManager.add(root, 'fake', 'Beta')
    const list = await channelManager.list(root)
    expect(list.filter((c) => c.type === 'fake').map((c) => c.name).sort()).toEqual(['Alpha', 'Beta'])
    expect(a).not.toBe(b)
  })

  it('registers WhatsApp and marks it configured only with official Cloud API config and secrets', async () => {
    const id = await channelManager.add(root, 'whatsapp', 'Fungi Channel')
    let wa = (await channelManager.list(root)).find((c) => c.id === id)
    expect(wa).toMatchObject({
      type: 'whatsapp',
      name: 'Fungi Channel',
      configured: false,
      graphVersion: DEFAULT_WHATSAPP_GRAPH_VERSION,
      webhookPort: DEFAULT_WHATSAPP_WEBHOOK_PORT
    })
    expect(wa?.webhookLocalUrl).toBe(`http://127.0.0.1:${DEFAULT_WHATSAPP_WEBHOOK_PORT}/assistant/whatsapp/${id}`)

    await setSecret(root, channelKey(id), 'ACCESS_TOKEN', [{ host: 'graph.facebook.com', port: 443, security: 'tls' }])
    await channelManager.setConfig(root, id, {
      phoneNumberId: 'PNID',
      allowFrom: ['15550100001'],
      publicCallbackUrl: 'https://example.com/assistant/whatsapp/fungi'
    })
    wa = (await channelManager.list(root)).find((c) => c.id === id)
    expect(wa?.configured).toBe(false)

    await setSecret(root, channelSecretKey(id, 'verifyToken'), 'VERIFY', [{ host: 'graph.facebook.com', port: 443, security: 'tls' }])
    await setSecret(root, channelSecretKey(id, 'appSecret'), 'APP_SECRET', [{ host: 'graph.facebook.com', port: 443, security: 'tls' }])
    wa = (await channelManager.list(root)).find((c) => c.id === id)
    expect(wa).toMatchObject({
      configured: true,
      phoneNumberId: 'PNID',
      allowFrom: ['15550100001'],
      publicCallbackUrl: 'https://example.com/assistant/whatsapp/fungi'
    })
  })

})

describe('telegram poll loop (resilience)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('does not revive an old polling loop after a stop and immediate restart', async () => {
    vi.useFakeTimers()
    let finishOld: (value: unknown) => void = () => {}
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve })).mockImplementation(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    const channel = createTelegramChannel()
    const oldMessage = vi.fn(), newMessage = vi.fn()
    const context = { token: 'opaque', allowFrom: ['1'], onError: vi.fn(), saveInbound: async () => ({ id: 'fixture-id', path: 'fixture.txt' }) }
    channel.start({ ...context, onMessage: oldMessage })
    channel.stop()
    channel.start({ ...context, onMessage: newMessage })
    finishOld({ ok: true, json: async () => ({ result: [{ update_id: 1, message: { text: 'stale', chat: { id: 1 } } }] }) })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(oldMessage).not.toHaveBeenCalled()
    expect(newMessage).not.toHaveBeenCalled()
    channel.stop()
  })

  it('nextBackoff doubles up to a 60s ceiling', () => {
    expect(nextBackoff(3_000)).toBe(6_000)
    expect(nextBackoff(6_000)).toBe(12_000)
    expect(nextBackoff(40_000)).toBe(60_000)
    expect(nextBackoff(60_000)).toBe(60_000)
  })

  it('keeps retrying a failing poll with widening backoff but logs the outage only once', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockRejectedValue(new Error('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)
    const channel = createTelegramChannel()
    const onError = vi.fn()
    channel.start({ token: 'TOK', allowFrom: [], onMessage: vi.fn(), onError, saveInbound: async () => ({ id: 'fixture-id', path: 'fixture.txt' }) })

    // First poll fails immediately → logged once.
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenLastCalledWith('fetch failed')

    // Past the 3s base backoff → 2nd attempt; past the widened 6s → 3rd.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // The identical sustained failure was deduped — still one log, and the
    // channel surfaces the live error for the Settings UI.
    expect(onError).toHaveBeenCalledTimes(1)
    expect(channel.lastError).toBe('fetch failed')

    channel.stop()
  })

  it('re-logs when the error message changes, then dedupes the repeat', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('err A'))
      .mockRejectedValueOnce(new Error('err B'))
      .mockRejectedValue(new Error('err B'))
    vi.stubGlobal('fetch', fetchMock)
    const channel = createTelegramChannel()
    const onError = vi.fn()
    channel.start({ token: 'TOK', allowFrom: [], onMessage: vi.fn(), onError, saveInbound: async () => ({ id: 'fixture-id', path: 'fixture.txt' }) })

    await vi.advanceTimersByTimeAsync(0) // err A → log #1
    expect(onError).toHaveBeenLastCalledWith('err A')
    await vi.advanceTimersByTimeAsync(3_000) // err B (changed) → log #2
    expect(onError).toHaveBeenLastCalledWith('err B')
    await vi.advanceTimersByTimeAsync(6_000) // err B (same) → deduped
    expect(onError).toHaveBeenCalledTimes(2)

    channel.stop()
  })

  it('clears the live error after a poll recovers', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, result: [] }) })
      // A real getUpdates long-polls ~25s; park the loop after recovery so the
      // instant-resolving mock can't spin a tight infinite loop under fake timers.
      .mockImplementation(() => new Promise<never>(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    const channel = createTelegramChannel()
    const onError = vi.fn(), onConnectionChange = vi.fn()
    channel.start({ token: 'TOK', allowFrom: [], onMessage: vi.fn(), onError, onConnectionChange, saveInbound: async () => ({ id: 'fixture-id', path: 'fixture.txt' }) })

    await vi.advanceTimersByTimeAsync(0) // fail → lastError set
    expect(channel.lastError).toBe('fetch failed')
    expect(channel.connected).toBe(false)
    await vi.advanceTimersByTimeAsync(3_000) // success → cleared, then parks
    expect(channel.lastError).toBeUndefined()
    expect(channel.connected).toBe(true)
    expect(onConnectionChange).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)

    channel.stop()
    expect(channel.connected).toBe(false)
    expect(onConnectionChange).toHaveBeenCalledTimes(2)
  })
})
