import type { PluginBackendApi } from '@valley/plugin-sdk'
import { initBackend } from '../src/backend/runtime'
vi.mock('../src/backend/channels/network', () => ({
  whatsappFetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  uploadFile: (url: string) => fetch(url)
}))
beforeEach(() => {
  initBackend({ credentials: { verify: async (request: { handle: string; comparison?: string; dataBase64?: string; signature?: string }) => {
    const secret = request.handle === 'VERIFY' ? 'VERIFY' : request.handle === 'APP_SECRET' ? 'APP_SECRET' : 'wrong'
    return request.comparison !== undefined ? request.comparison === secret : createHmac('sha256', secret).update(Buffer.from(request.dataBase64!, 'base64')).digest('hex') === request.signature
  } } } as unknown as PluginBackendApi)
})
import { createHmac } from 'node:crypto'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildButtonsPayload,
  buildTextPayload,
  createWhatsAppChannel,
  DEFAULT_WHATSAPP_GRAPH_VERSION,
  normalizeGraphVersion,
  parseWhatsAppWebhook,
  verifyWebhookChallenge,
  verifyWebhookSignature,
  whatsappLocalCallbackUrl,
  whatsappWebhookPath
} from '../src/backend/channels/whatsapp'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('whatsapp adapter (official Cloud API)', () => {
  it('verifies the webhook challenge using an opaque credential handle', async () => {
    const ok = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'VERIFY', 'hub.challenge': 'CHALLENGE' })
    const bad = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'CHALLENGE' })

    expect(await verifyWebhookChallenge(ok, 'VERIFY')).toBe('CHALLENGE')
    expect(await verifyWebhookChallenge(bad, 'VERIFY')).toBeNull()
    expect(await verifyWebhookChallenge(ok, null)).toBeNull()
  })

  it('verifies Meta X-Hub-Signature-256 through the credential broker', async () => {
    const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }))
    const signature = `sha256=${createHmac('sha256', 'APP_SECRET').update(body).digest('hex')}`

    expect(await verifyWebhookSignature(body.toString('base64'), signature, 'APP_SECRET')).toBe(true)
    expect(await verifyWebhookSignature(body.toString('base64'), signature, 'wrong')).toBe(false)
    expect(await verifyWebhookSignature(body.toString('base64'), 'sha1=bad', 'APP_SECRET')).toBe(false)
  })

  it('parses text, button/list replies, and media messages while ignoring status-only payloads', () => {
    expect(parseWhatsAppWebhook({ entry: [{ changes: [{ value: { statuses: [{ id: 'sent' }] } }] }] })).toEqual([])

    const parsed = parseWhatsAppWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: '15550100001', profile: { name: 'Fern' } }],
                messages: [
                  { id: 'in-0', from: '15550100001', type: 'text', text: { body: 'hi' } },
                  { id: 'in-1', from: '15550100001', type: 'interactive', interactive: { button_reply: { id: 'allow:r1', title: 'Allow once' } } },
                  { id: 'in-2', from: '15550100001', type: 'interactive', interactive: { list_reply: { id: 'model:openai:gpt-5.5', title: 'GPT-5.5' } } },
                  { id: 'in-3', from: '15550100001', type: 'image', image: { id: 'img-1', mime_type: 'image/jpeg', caption: 'look' } },
                  { id: 'in-4', from: '15550100001', type: 'audio', audio: { id: 'aud-1', mime_type: 'audio/ogg' } },
                  { id: 'in-5', from: '15550100001', type: 'document', document: { id: 'doc-1', mime_type: 'application/pdf', filename: 'field-guide.pdf', caption: 'habitat' } }
                ]
              }
            }
          ]
        }
      ]
    })

    expect(parsed[0]).toMatchObject({ chatRef: '15550100001', from: 'Fern', text: 'hi' })
    expect(parsed[1]).toMatchObject({ chatRef: '15550100001', text: 'Allow once', data: 'allow:r1' })
    expect(parsed[2]).toMatchObject({ chatRef: '15550100001', text: 'GPT-5.5', data: 'model:openai:gpt-5.5' })
    expect(parsed[3]).toMatchObject({ text: 'look', mediaSpecs: [{ mediaId: 'img-1', kind: 'image', fileName: 'img-1.jpg', mime: 'image/jpeg' }] })
    expect(parsed[4]).toMatchObject({ text: '', mediaSpecs: [{ mediaId: 'aud-1', kind: 'audio', fileName: 'aud-1.ogg', mime: 'audio/ogg' }] })
    expect(parsed[5]).toMatchObject({ text: 'habitat', mediaSpecs: [{ mediaId: 'doc-1', kind: 'pdf', fileName: 'field-guide.pdf', mime: 'application/pdf' }] })
  })

  it('builds official text, reply-button, and list-message payloads', () => {
    expect(buildTextPayload('15550100001', 'hello')).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15550100001',
      type: 'text',
      text: { preview_url: true, body: 'hello' }
    })

    const buttonPayload = buildButtonsPayload('15550100001', 'Confirm?', [
      { label: 'Allow once', value: 'allow:r1' },
      { label: 'Skip', value: 'skip:r1' }
    ])
    expect(buttonPayload).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'button'
      }
    })
    expect(((buttonPayload.interactive as { action: { buttons: { reply: { id: string; title: string } }[] } }).action.buttons).map((b) => b.reply)).toEqual([
      { id: 'allow:r1', title: 'Allow once' },
      { id: 'skip:r1', title: 'Skip' }
    ])

    const listPayload = buildButtonsPayload('15550100001', 'Pick one:', [
      { label: 'A', value: 'a' },
      { label: 'B', value: 'b' },
      { label: 'C', value: 'c' },
      { label: 'D', value: 'd' }
    ])
    expect(listPayload).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'list',
        action: { button: 'Choose' }
      }
    })
    expect(((listPayload.interactive as { action: { sections: { rows: { id: string; title: string }[] }[] } }).action.sections[0].rows).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('sends text, buttons, and uploaded media through the official Graph endpoints', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'media-1' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    const file = '/vault/field-guide.pdf'

    const channel = createWhatsAppChannel('whatsapp-1')
    const config = { type: 'whatsapp', phoneNumberId: 'PNID', graphVersion: DEFAULT_WHATSAPP_GRAPH_VERSION }
    await channel.send('TOKEN', '15550100001', 'hello', config)
    await channel.sendButtons?.('TOKEN', '15550100001', 'Confirm?', [{ label: 'Allow', value: 'allow:r1' }], config)
    await channel.sendAttachment?.('TOKEN', '15550100001', file, 'caption', config)

    expect(fetchMock.mock.calls[0][0]).toBe('https://graph.facebook.com/v25.0/PNID/messages')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ type: 'text', text: { body: 'hello' } })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ type: 'interactive', interactive: { type: 'button' } })
    expect(fetchMock.mock.calls[2][0]).toBe('https://graph.facebook.com/v25.0/PNID/media')
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toMatchObject({ type: 'document', document: { id: 'media-1', caption: 'caption', filename: 'field-guide.pdf' } })

  })

  it('normalizes Graph versions and exposes the local callback path', () => {
    expect(normalizeGraphVersion('25.0')).toBe('v25.0')
    expect(normalizeGraphVersion('v24.0')).toBe('v24.0')
    expect(whatsappWebhookPath('whatsapp-1')).toBe('/assistant/whatsapp/whatsapp-1')
    expect(whatsappLocalCallbackUrl('whatsapp-1', 8787)).toBe('http://127.0.0.1:8787/assistant/whatsapp/whatsapp-1')
  })
})


it('closes a late webhook listener through its captured API and joins it on stop', async () => {
  let finish!: (value: { listenerId: string; address: string }) => void
  const original = { webhook: { listen: vi.fn(() => new Promise<{ listenerId: string; address: string }>(resolve => { finish = resolve })), close: vi.fn(async () => {}), onRequest: vi.fn(() => () => {}) } }
  initBackend(original as unknown as PluginBackendApi)
  const channel = createWhatsAppChannel('owned', 'Owned')
  channel.start({ token: 'token', config: { type: 'whatsapp', phoneNumberId: 'number' }, secrets: { verifyToken: 'verify', appSecret: 'secret' }, allowFrom: [], onMessage: vi.fn(), onError: vi.fn(), saveInbound: vi.fn(async () => ({ id: 'fixture-id', path: 'fixture.txt' })) })
  let stopped = false
  const stopping = Promise.resolve(channel.stop()).then(() => { stopped = true })
  const replacement = { webhook: { close: vi.fn(async () => {}) } }
  initBackend(replacement as unknown as PluginBackendApi)
  await Promise.resolve(); expect(stopped).toBe(false)
  finish({ listenerId: 'old-listener', address: 'http://localhost' })
  await stopping
  expect(original.webhook.close).toHaveBeenCalledOnce()
  expect(original.webhook.close).toHaveBeenCalledWith('old-listener')
  expect(replacement.webhook.close).not.toHaveBeenCalled()
  expect(original.webhook.onRequest).not.toHaveBeenCalled()
})


it('marks WhatsApp connected only after an authenticated webhook and clears it on stop', async () => {
  let receive!: (request: import('@valley/plugin-sdk/pluginWebhook').PluginWebhookRequest) => void
  const respond = vi.fn(async () => {})
  const verify = vi.fn(async () => false)
  initBackend({ credentials: { verify }, webhook: {
    listen: async () => ({ listenerId: 'canopy-listener', address: 'http://localhost' }),
    close: async () => {}, respond,
    onRequest: (callback: typeof receive) => { receive = callback; return () => {} }
  } } as unknown as PluginBackendApi)
  const channel = createWhatsAppChannel('canopy')
  const onConnectionChange = vi.fn()
  channel.start({ token: 'token', config: { type: 'whatsapp', phoneNumberId: 'number' }, secrets: { verifyToken: 'verify', appSecret: 'secret' }, allowFrom: [], onMessage: vi.fn(), onError: vi.fn(), onConnectionChange, saveInbound: vi.fn(async () => ({ id: 'fixture-id', path: 'fixture.txt' })) })
  await vi.waitFor(() => expect(receive).toBeDefined())
  expect(channel.running).toBe(true)
  expect(channel.connected).toBe(false)
  const request = { listenerId: 'canopy-listener', requestId: 'request', method: 'POST', path: '/', headers: { 'x-hub-signature-256': 'sha256=signature' }, bodyBase64: Buffer.from(JSON.stringify({ entry: [] })).toString('base64') }
  receive(request)
  await vi.waitFor(() => expect(respond).toHaveBeenCalled())
  expect(channel.connected).toBe(false)
  verify.mockResolvedValue(true)
  receive(request)
  await vi.waitFor(() => expect(channel.connected).toBe(true))
  expect(onConnectionChange).toHaveBeenCalledOnce()
  await channel.stop()
  expect(channel.connected).toBe(false)
  expect(onConnectionChange).toHaveBeenCalledTimes(2)
})
