import { t } from '../runtime'
import { backendApi } from '../runtime'
import { whatsappFetch, uploadFile, readBoundedMedia } from './network'
import type { PluginWebhookRequest } from '@valley/plugin-sdk/pluginWebhook'
import path from 'path-browserify'
import type {
  ChannelButton,
  ChannelLifecycleEvent,
  InboundMediaSpec,
  ChannelInboundMessage,
  ChannelRuntimeConfig,
  InboundAttachmentRef,
  MessagingChannel,
  MessagingChannelContext
} from './types'

const GRAPH = 'https://graph.facebook.com'
export const DEFAULT_WHATSAPP_GRAPH_VERSION = 'v25.0'
export const DEFAULT_WHATSAPP_WEBHOOK_PORT = 8787

interface WhatsAppConfig {
  phoneNumberId: string
  graphVersion: string
  webhookPort: number
}

export interface WhatsAppMediaSpec {
  mediaId: string
  kind: InboundAttachmentRef['kind']
  fileName: string
  mime?: string
  metadata?: InboundMediaSpec['metadata']
}

export type ParsedWhatsAppMessage = ChannelInboundMessage & { mediaSpecs?: WhatsAppMediaSpec[] }

export function whatsappWebhookPath(channelId: string): string {
  return `/assistant/whatsapp/${encodeURIComponent(channelId)}`
}

export function whatsappLocalCallbackUrl(channelId: string, port = DEFAULT_WHATSAPP_WEBHOOK_PORT): string {
  return `http://127.0.0.1:${port}${whatsappWebhookPath(channelId)}`
}

export function normalizeGraphVersion(version?: string): string {
  const v = (version || DEFAULT_WHATSAPP_GRAPH_VERSION).trim()
  return v.startsWith('v') ? v : `v${v}`
}

function normalizeConfig(config?: ChannelRuntimeConfig): WhatsAppConfig {
  const phoneNumberId = config?.phoneNumberId?.trim() ?? ''
  const webhookPort = Number.isFinite(config?.webhookPort) && config?.webhookPort ? Number(config.webhookPort) : DEFAULT_WHATSAPP_WEBHOOK_PORT
  return { phoneNumberId, graphVersion: normalizeGraphVersion(config?.graphVersion), webhookPort }
}

export async function verifyWebhookChallenge(params: URLSearchParams, verifyToken: string | null | undefined): Promise<string | null> {
  if (params.get('hub.mode') !== 'subscribe' || !verifyToken) return null
  if (!await backendApi().credentials.verify({ handle: verifyToken, comparison: params.get('hub.verify_token') ?? '' })) return null
  return params.get('hub.challenge')
}
export async function verifyWebhookSignature(rawBody: string, signature: string | undefined, appSecret: string | null | undefined): Promise<boolean> {
  if (!appSecret || !signature?.startsWith('sha256=')) return false
  return backendApi().credentials.verify({ handle: appSecret, algorithm: 'sha256', dataBase64: rawBody, signature: signature.slice(7), encoding: 'hex' })
}

function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : []
}

function mimeExtension(mime?: string): string {
  if (mime === 'application/pdf') return '.pdf'
  if (mime === 'image/png') return '.png'
  if (mime === 'image/webp') return '.webp'
  if (mime === 'image/gif') return '.gif'
  if (mime?.split(';')[0] === 'audio/ogg') return '.ogg'
  if (mime === 'audio/mpeg') return '.mp3'
  if (mime === 'video/mp4') return '.mp4'
  if (mime === 'video/3gpp') return '.3gp'
  if (mime?.startsWith('image/')) return '.jpg'
  return ''
}

function mediaKind(type: string, mime?: string, fileName?: string): InboundAttachmentRef['kind'] {
  if (type === 'image' || type === 'sticker') return 'image'
  if (type === 'audio') return 'audio'
  if (mime === 'application/pdf' || /\.pdf$/i.test(fileName ?? '')) return 'pdf'
  return 'file'
}

function contactName(value: { contacts?: { wa_id?: string; profile?: { name?: string } }[] } | undefined, waId: string): string | undefined {
  return value?.contacts?.find((c) => c.wa_id === waId)?.profile?.name
}

interface WhatsAppIncoming {
  from?: string
  id?: string
  type?: string
  timestamp?: string
  context?: { id?: string }
  text?: { body?: string }
  button?: { text?: string; payload?: string }
  interactive?: { button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } }
  image?: WhatsAppPayloadMedia
  audio?: WhatsAppPayloadMedia
  document?: WhatsAppPayloadMedia
  video?: WhatsAppPayloadMedia
  sticker?: WhatsAppPayloadMedia
  contacts?: Array<{ name?: { first_name?: string; last_name?: string; formatted_name?: string }; phones?: Array<{ phone?: string }>; emails?: Array<{ email?: string }>; org?: { company?: string } }>
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id?: string; emoji?: string }
}
interface WhatsAppPayloadMedia { id?: string; mime_type?: string; caption?: string; filename?: string; voice?: boolean; animated?: boolean }
interface WhatsAppValue {
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>
  messages?: WhatsAppIncoming[]
  statuses?: Array<{ id?: string; recipient_id?: string; status?: string; timestamp?: string; errors?: Array<{ title?: string; message?: string }> }>
}
function webhookValues(payload: unknown): WhatsAppValue[] {
  const root = payload as { entry?: Array<{ changes?: Array<{ value?: WhatsAppValue }> }> } | null
  return asArray(root?.entry).flatMap(entry => asArray(entry.changes).map(change => change.value).filter((value): value is WhatsAppValue => Boolean(value)))
}
export function parseWhatsAppWebhook(payload: unknown): ParsedWhatsAppMessage[] {
  const messages: ParsedWhatsAppMessage[] = []
  for (const value of webhookValues(payload)) for (const msg of asArray(value.messages)) {
    if (!msg.from || !msg.id || msg.reaction) continue
    const base: ChannelInboundMessage = { providerEventId: msg.id, providerMessageId: msg.id, senderId: msg.from, chatType: 'private', chatRef: msg.from, from: contactName(value, msg.from) ?? msg.from, text: '', ...(msg.timestamp && Number.isFinite(Number(msg.timestamp)) ? { receivedAt: Number(msg.timestamp) * 1000 } : {}), ...(msg.context?.id ? { replyToMessageId: msg.context.id } : {}) }
    if (msg.text?.body != null) { messages.push({ ...base, text: msg.text.body }); continue }
    const interactive = msg.interactive?.button_reply ?? msg.interactive?.list_reply
    if (interactive?.id || msg.button?.payload) { messages.push({ ...base, text: interactive?.title ?? msg.button?.text ?? '', data: interactive?.id ?? msg.button?.payload, callbackMessageId: msg.context?.id }); continue }
    if (msg.contacts?.length) {
      messages.push({ ...base, contacts: msg.contacts.map(contact => ({ firstName: contact.name?.first_name ?? contact.name?.formatted_name ?? '', lastName: contact.name?.last_name, phone: contact.phones?.[0]?.phone ?? '', email: contact.emails?.[0]?.email, organization: contact.org?.company })) }); continue
    }
    if (msg.location) { messages.push({ ...base, location: msg.location }); continue }
    const type = msg.type
    const media = type === 'image' ? msg.image : type === 'audio' ? msg.audio : type === 'video' ? msg.video : type === 'sticker' ? msg.sticker : type === 'document' ? msg.document : undefined
    if (!media?.id || !type) continue
    const fileName = media.filename || `${media.id}${mimeExtension(media.mime_type)}`
    const metadata: InboundMediaSpec['metadata'] = { media: type === 'document' ? 'file' : type === 'audio' ? media.voice ? 'voice' : 'audio' : type as 'image' | 'video' | 'sticker', providerFileId: media.id, animated: media.animated }
    const spec = { mediaId: media.id, kind: mediaKind(type, media.mime_type, fileName), fileName, mime: media.mime_type, metadata }
    messages.push({ ...base, text: media.caption ?? '', mediaSpecs: [spec], media: [{ ...spec, provider: 'whatsapp' }] })
  }
  return messages
}
export function parseWhatsAppLifecycle(payload: unknown): ChannelLifecycleEvent[] {
  const events: ChannelLifecycleEvent[] = []
  for (const value of webhookValues(payload)) {
    for (const status of asArray(value.statuses)) {
      if (!status.id || !status.recipient_id || !['delivered', 'read', 'failed'].includes(status.status ?? '')) continue
      events.push({ type: 'receipt', providerEventId: `${status.id}:${status.status}:${status.timestamp ?? ''}`, chatRef: status.recipient_id, providerMessageId: status.id, state: status.status!.toUpperCase() as 'DELIVERED' | 'READ' | 'FAILED', error: status.errors?.map(error => error.message ?? error.title).filter(Boolean).join('; ') || undefined })
    }
    for (const msg of asArray(value.messages)) {
      if (!msg.id || !msg.from) continue
      if (msg.reaction?.message_id) events.push({ type: 'reaction', providerEventId: msg.id, chatRef: msg.from, providerMessageId: msg.reaction.message_id, emoji: msg.reaction.emoji ?? '' })
      else if (msg.type && !['text', 'button', 'interactive', 'image', 'audio', 'document', 'video', 'sticker', 'contacts', 'location'].includes(msg.type)) events.push({ type: 'unsupported', providerEventId: msg.id, chatRef: msg.from, providerMessageId: msg.id, error: `Unsupported WhatsApp message type: ${msg.type}` })
    }
  }
  return events
}

function isAllowed(chatRef: string, allowFrom: string[]): boolean {
  if (!allowFrom.length) return false
  return allowFrom.map((s) => s.trim()).includes(chatRef)
}

function limitText(text: string, max: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= max ? compact : compact.slice(0, Math.max(1, max - 1)).trimEnd()
}

function baseMessage(to: string): Record<string, unknown> {
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to }
}

export function buildTextPayload(chatRef: string, text: string): Record<string, unknown> {
  return { ...baseMessage(chatRef), type: 'text', text: { preview_url: true, body: text } }
}

export function buildButtonsPayload(chatRef: string, text: string, buttons: ChannelButton[]): Record<string, unknown> {
  if (buttons.length <= 3) {
    return {
      ...baseMessage(chatRef),
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text },
        action: {
          buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.value, title: limitText(b.label, 20) } }))
        }
      }
    }
  }
  return {
    ...baseMessage(chatRef),
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text },
      action: {
        button: t('assistant.backend.choose'),
        sections: [
          {
            title: 'Options',
            rows: buttons.slice(0, 10).map((b) => ({ id: b.value, title: limitText(b.label, 24) }))
          }
        ]
      }
    }
  }
}

function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime'
  }
  return map[ext] ?? 'application/octet-stream'
}

function outboundMediaType(mime: string): 'image' | 'audio' | 'video' | 'document' {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  return 'document'
}

async function postJson(token: string, cfg: WhatsAppConfig, body: Record<string, unknown>): Promise<void> {
  if (!cfg.phoneNumberId) throw new Error(t('assistant.backend.missingPhone'))
  const res = await whatsappFetch(`${GRAPH}/${cfg.graphVersion}/${cfg.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(t('assistant.backend.operationFailed', { operation: 'WhatsApp', status: res.status }))
}

async function uploadMedia(token: string, cfg: WhatsAppConfig, absPath: string, mime: string): Promise<string> {
  if (!cfg.phoneNumberId) throw new Error(t('assistant.backend.missingPhone'))
  const res = await uploadFile(`${GRAPH}/${cfg.graphVersion}/${cfg.phoneNumberId}/media`, { handle: token, placement: 'header', name: 'Authorization', prefix: 'Bearer ' }, absPath, { messaging_product: 'whatsapp', type: mime }, 'file')
  if (!res.ok) throw new Error(t('assistant.backend.operationFailed', { operation: 'WhatsApp', status: res.status }))
  const id = ((await res.json()) as { id?: string }).id
  if (!id) throw new Error(t('assistant.backend.invalidMedia'))
  return id
}

async function sendMedia(token: string, cfg: WhatsAppConfig, chatRef: string, absPath: string, caption?: string, attachment?: ChannelRuntimeConfig['attachment']): Promise<void> {
  const mime = attachment?.mime || mimeForPath(absPath)
  const type = outboundMediaType(mime)
  const id = await uploadMedia(token, cfg, absPath, mime)
  const fileName = attachment?.fileName ?? path.basename(absPath)
  if (caption && type === 'audio') await postJson(token, cfg, buildTextPayload(chatRef, caption))
  const media: Record<string, unknown> = { id }
  if (caption && type !== 'audio') media.caption = caption
  if (type === 'document') media.filename = fileName
  await postJson(token, cfg, { ...baseMessage(chatRef), type, [type]: media })
}

export async function openWhatsAppMedia(token: string, graphVersion: string, spec: WhatsAppMediaSpec, signal?: AbortSignal, refresh = true): Promise<{ response: Response; fileName: string; mime?: string }> {
  const meta = await whatsappFetch(`${GRAPH}/${graphVersion}/${spec.mediaId}`, {
    headers: { authorization: `Bearer ${token}` }, signal
  })
  if (!meta.ok) throw new Error(t('assistant.backend.operationFailed', { operation: 'WhatsApp', status: meta.status }))
  const info = (await meta.json()) as { url?: string; mime_type?: string }
  if (!info.url) throw new Error(t('assistant.backend.invalidMedia'))
  const file = await whatsappFetch(info.url, { headers: { authorization: `Bearer ${token}` }, signal })
  if (refresh && (file.status === 401 || file.status === 403)) { await file.body?.cancel(); return openWhatsAppMedia(token, graphVersion, spec, signal, false) }
  if (!file.ok) throw new Error(t('assistant.backend.operationFailed', { operation: 'WhatsApp', status: file.status }))
  const mime = info.mime_type ?? spec.mime
  const hasExt = Boolean(path.extname(spec.fileName))
  const fileName = hasExt ? spec.fileName : `${spec.fileName}${mimeExtension(mime)}`
  return { response: file, fileName, mime }
}

export async function downloadMedia(token: string, graphVersion: string, spec: WhatsAppMediaSpec, signal?: AbortSignal): Promise<{ bytes: Uint8Array; fileName: string; mime?: string }> {
  const media = await openWhatsAppMedia(token, graphVersion, spec, signal)
  return { bytes: await readBoundedMedia(media.response, 32 * 1024 * 1024, signal), fileName: media.fileName, mime: media.mime }
}

async function send(request: PluginWebhookRequest, status: number, body: string, api = backendApi()): Promise<void> {
  const bytes = new TextEncoder().encode(body)
  await api.webhook.respond(request.requestId, { status, headers: { 'content-type': 'text/plain; charset=utf-8' }, bodyBase64: btoa(String.fromCharCode(...bytes)) })
}

export function createWhatsAppChannel(id = 'whatsapp', name = 'WhatsApp'): MessagingChannel {
  let running = false
  let listenerId: string | null = null
  let unsubscribe: (() => void) | null = null
  let generation = 0
  let ctx: MessagingChannelContext | null = null
  let listenerOwner: ReturnType<typeof backendApi> | undefined
  const pending = new Set<Promise<unknown>>()
  const track = <T>(task: Promise<T>): Promise<T> => {
    pending.add(task)
    void task.then(() => pending.delete(task), () => pending.delete(task))
    return task
  }

  function reportError(message: string): void {
    channel.connected = false
    channel.lastError = message
    ctx?.onError(message)
  }

  async function handlePost(req: PluginWebhookRequest, owner: ReturnType<typeof backendApi>): Promise<void> {
    const context = ctx
    const version = generation
    const current = (): boolean => running && generation === version && ctx === context && backendApi() === owner
    const reply = (status: number, body: string) => send(req, status, body, owner)
    if (!context || !current()) return reply(503, 'not running')
    const raw = req.bodyBase64
    const appSecret = context.secrets?.appSecret
    if (!await verifyWebhookSignature(raw, req.headers['x-hub-signature-256'], appSecret)) return reply(401, 'bad signature')
    if (!current()) return reply(503, 'not running')
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), (character) => character.charCodeAt(0))))
    } catch {
      return reply(400, 'bad json')
    }
    const graphVersion = normalizeGraphVersion(context.config?.graphVersion)
    for (const event of parseWhatsAppLifecycle(parsed)) if (isAllowed(event.chatRef, context.allowFrom)) await context.onLifecycle?.(event)
    for (const msg of parseWhatsAppWebhook(parsed)) {
      if (!current()) return reply(503, 'not running')
      if (!isAllowed(msg.chatRef, context.allowFrom)) continue
      if (context.ingest) { await context.ingest(msg); continue }
      const attachments: InboundAttachmentRef[] = []
      for (const spec of msg.mediaSpecs ?? []) {
        try {
          const media = await downloadMedia(context.token, graphVersion, spec)
          if (!current()) return reply(503, 'not running')
          const savedPath = await context.saveInbound({ bytes: media.bytes, fileName: media.fileName, chatRef: msg.chatRef })
          attachments.push({ kind: spec.kind, id: savedPath.id, path: savedPath.path, fileName: media.fileName, mime: media.mime ?? spec.mime, metadata: spec.metadata })
        } catch (err) {
          throw new Error(t('assistant.backend.attachmentFailed', { value: err instanceof Error ? err.message : String(err) }))
        }
      }
      if (!current()) return reply(503, 'not running')
      await context.onMessage({ providerEventId: msg.providerEventId, providerMessageId: msg.providerMessageId, senderId: msg.senderId, chatType: msg.chatType, chatRef: msg.chatRef, from: msg.from, text: msg.text, data: msg.data, ...(attachments.length ? { attachments } : {}) })
    }
    const changed = !channel.connected || Boolean(channel.lastError)
    channel.connected = true
    channel.lastError = undefined
    if (changed) context.onConnectionChange?.()
    await reply(200, 'OK')
  }

  async function startServer(next: MessagingChannelContext): Promise<void> {
    const version = ++generation
    const owner = backendApi()
    const cfg = normalizeConfig(next.config)
    const verifyToken = next.secrets?.verifyToken
    if (!cfg.phoneNumberId || !verifyToken || !next.secrets?.appSecret) throw new Error(t('assistant.backend.incompleteWhatsApp'))
    const listener = await owner.webhook.listen({ port: cfg.webhookPort, path: whatsappWebhookPath(id) })
    if (!running || generation !== version || backendApi() !== owner) { await owner.webhook.close(listener.listenerId); return }
    listenerId = listener.listenerId
    listenerOwner = owner
    unsubscribe = owner.webhook.onRequest((req) => {
      if (req.listenerId !== listenerId || generation !== version || backendApi() !== owner) return
      void track((async () => {
        const url = new URL(req.path, 'http://127.0.0.1')
        if (req.method === 'GET') {
          const challenge = await verifyWebhookChallenge(url.searchParams, verifyToken)
          return challenge == null ? send(req, 403, 'bad verify token', owner) : send(req, 200, challenge, owner)
        }
        if (req.method === 'POST') return handlePost(req, owner)
        return send(req, 405, 'method not allowed', owner)
      })().catch(async error => { if (generation === version) reportError(error instanceof Error ? error.message : String(error)); await send(req, 500, 'error', owner).catch(() => undefined) }))
    })
  }

  const channel: MessagingChannel = {
    id,
    type: 'whatsapp',
    displayName: name,
    running: false,
    connected: false,
    start(next): void {
      ctx = next
      if (running) return
      running = true
      channel.running = true
      channel.connected = false
      channel.lastError = undefined
      const version = generation + 1
      void track(startServer(next).catch(error => { if (version !== generation) return; running = false; channel.running = false; reportError(error instanceof Error ? error.message : String(error)) }))
    },
    async stop(): Promise<void> {
      running = false
      channel.running = false
      channel.connected = false
      ctx?.onConnectionChange?.()
      ctx = null
      generation++
      unsubscribe?.(); unsubscribe = null
      const current = listenerId; listenerId = null
      const owner = listenerOwner; listenerOwner = undefined
      const closing = current && owner ? owner.webhook.close(current) : Promise.resolve()
      const result = await Promise.allSettled([closing, ...pending])
      while (pending.size) await Promise.allSettled([...pending])
      if (result[0].status === 'rejected') throw result[0].reason
    },
    async send(token, chatRef, text, config): Promise<void> {
      await postJson(token, normalizeConfig(config), buildTextPayload(chatRef, text))
    },
    async sendButtons(token, chatRef, text, buttons, config): Promise<void> {
      await postJson(token, normalizeConfig(config), buildButtonsPayload(chatRef, text, buttons))
    },
    async sendAttachment(token, chatRef, absPath, caption, config): Promise<void> {
      await sendMedia(token, normalizeConfig(config), chatRef, absPath, caption, config?.attachment)
    },
    async registerCommands(): Promise<void> {
      return
    }
  }
  return channel
}
