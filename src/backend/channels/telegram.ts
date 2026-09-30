import { t } from '../runtime'
import { telegramFetch, uploadFile, readBoundedMedia } from './network'
import path from 'path-browserify'
import { valleyCancellationOf, withValleyCancellation } from '@valley/plugin-sdk/valleyCancellation'
import type { ChannelInboundMessage, ChannelLifecycleEvent, InboundAttachmentRef, MessagingChannel, MessagingChannelContext } from './types'
import type { ChannelMediaMetadata } from '../../contracts/channel'
import { formatTextParts } from './formatting'

/**
 * Telegram Bot API adapter — long-polls `getUpdates` (offset loop) and replies
 * via `sendMessage`. The bot token is created by the user with @BotFather and
 * stored encrypted; only chat ids in the allow-list are accepted. Inline-keyboard
 * buttons (`sendButtons`) come back as `callback_query` updates, parsed into
 * `data`-carrying messages and acked so Telegram clears the button spinner. Pure
 * helpers (`parseUpdates`, `isAllowed`) are exported for unit testing.
 */
const API = 'https://api.telegram.org'

// getUpdates long-polls for `timeout=25`s; abort a little past that so a wedged
// socket can never freeze the poll loop forever (Node's fetch has no default).
const POLL_TIMEOUT_MS = 30_000
const BACKOFF_BASE_MS = 3_000
const BACKOFF_MAX_MS = 60_000

/** Exponential backoff with a ceiling — widens the retry gap during an outage
 *  (network down, bad token) so we don't hammer the API or flood the console. */
export function nextBackoff(ms: number): number {
  return Math.min(ms * 2, BACKOFF_MAX_MS)
}

interface TgUser {
  id?: number
  username?: string
  first_name?: string
}
interface TgFile {
  file_id?: string
  file_name?: string
  mime_type?: string
  file_size?: number
  file_unique_id?: string
  width?: number
  height?: number
  duration?: number
  is_animated?: boolean
  is_video?: boolean
  emoji?: string
  set_name?: string
  thumbnail?: TgFile
}
interface TgPhotoSize extends TgFile {
  width?: number
  height?: number
}
interface TgMessage {
  message_id?: number
  message_thread_id?: number
  text?: string
  caption?: string
  chat?: { id?: number; username?: string; first_name?: string; type?: string }
  from?: TgUser
  photo?: TgPhotoSize[]
  document?: TgFile
  voice?: TgFile
  audio?: TgFile
  video?: TgFile
  video_note?: TgFile
  animation?: TgFile
  sticker?: TgFile
  date?: number
  reply_to_message?: { message_id?: number }
  contact?: { phone_number: string; first_name: string; last_name?: string; vcard?: string }
  location?: { latitude: number; longitude: number; live_period?: number }
  venue?: { location: { latitude: number; longitude: number }; title: string; address: string }
}
interface TgUpdate {
  update_id: number
  message?: TgMessage
  edited_message?: TgMessage
  message_reaction?: { chat?: { id?: number }; message_id?: number; new_reaction?: Array<{ emoji?: string }> }
  callback_query?: {
    id?: string
    data?: string
    from?: TgUser
    message?: { message_id?: number; message_thread_id?: number; chat?: { id?: number; username?: string; type?: string } }
  }
}

const verifiedChatType = (value?: string): ChannelInboundMessage['chatType'] => ['private', 'group', 'supergroup', 'channel'].includes(value ?? '') ? value as ChannelInboundMessage['chatType'] : undefined

/** A file the message referenced, to be downloaded by the loop (getFile → bytes). */
export interface TgAttachmentSpec {
  fileId: string
  kind: InboundAttachmentRef['kind']
  fileName: string
  mime?: string
  metadata?: ChannelMediaMetadata
}

type ParsedMessage = ChannelInboundMessage & { chatId: string; attachmentSpecs?: TgAttachmentSpec[] }

export function parseAttachment(m: TgMessage): TgAttachmentSpec | null {
  const typed = (file: TgFile, media: ChannelMediaMetadata['media'], kind: InboundAttachmentRef['kind'], extension: string, mime: string): TgAttachmentSpec => ({
    fileId: file.file_id!, kind, fileName: file.file_name || `${file.file_id}${extension}`, mime: file.mime_type || mime,
    metadata: { media, providerFileId: file.file_id, providerUniqueId: file.file_unique_id, bytes: file.file_size, width: file.width, height: file.height, duration: file.duration, animated: file.is_animated, video: file.is_video, emoji: file.emoji, stickerSet: file.set_name, thumbnailFileId: file.thumbnail?.file_id }
  })
  if (m.sticker?.file_id) return typed(m.sticker, 'sticker', m.sticker.is_animated || m.sticker.is_video ? 'file' : 'image', m.sticker.is_animated ? '.tgs' : m.sticker.is_video ? '.webm' : '.webp', m.sticker.is_animated ? 'application/x-tgsticker' : m.sticker.is_video ? 'video/webm' : 'image/webp')
  if (m.video_note?.file_id) return typed(m.video_note, 'videoNote', 'file', '.mp4', 'video/mp4')
  if (m.animation?.file_id) return typed(m.animation, 'animation', 'file', '.mp4', 'video/mp4')
  if (Array.isArray(m.photo) && m.photo.length) {
    const largest = m.photo.reduce((a, b) => ((b.file_size ?? 0) >= (a.file_size ?? 0) ? b : a))
    if (largest.file_id) return { fileId: largest.file_id, kind: 'image', fileName: `${largest.file_id}.jpg`, mime: 'image/jpeg' }
  }
  if (m.voice?.file_id) return typed(m.voice, 'voice', 'audio', '.ogg', 'audio/ogg')
  if (m.audio?.file_id) return typed(m.audio, 'audio', 'audio', '.mp3', 'audio/mpeg')
  if (m.video?.file_id) return typed(m.video, 'video', 'file', '.mp4', 'video/mp4')
  if (m.document?.file_id) {
    const name = m.document.file_name || m.document.file_id
    const isPdf = /\.pdf$/i.test(name) || m.document.mime_type === 'application/pdf'
    const isImage = /^image\//.test(m.document.mime_type ?? '') || /\.(png|jpe?g|gif|webp)$/i.test(name)
    return { fileId: m.document.file_id, kind: isPdf ? 'pdf' : isImage ? 'image' : 'file', fileName: name, mime: m.document.mime_type }
  }
  return null
}

/**
 * Parse a getUpdates response into inbound messages + the next polling offset.
 * Both plain text messages and button taps (`callback_query`) become inbound
 * messages — a tap carries its `data` and empty `text`; `callbackIds` lists the
 * callback ids to ack so Telegram stops the button's loading state.
 */
export function parseUpdates(json: unknown): {
  messages: ParsedMessage[]
  nextOffset: number | null
  callbackIds: string[]
  lifecycle: ChannelLifecycleEvent[]
} {
  const result = (json as { ok?: boolean; result?: TgUpdate[] }) ?? {}
  const updates = Array.isArray(result.result) ? result.result : []
  const messages: ParsedMessage[] = []
  const callbackIds: string[] = []
  const lifecycle: ChannelLifecycleEvent[] = []
  let maxId = -Infinity
  for (const u of updates) {
    if (typeof u.update_id === 'number') maxId = Math.max(maxId, u.update_id)
    const edited = u.edited_message
    if (edited?.chat?.id !== undefined && edited.message_id !== undefined) lifecycle.push({ type: edited.location ? 'liveLocation' : 'edited', providerEventId: String(u.update_id), chatRef: String(edited.chat.id), providerMessageId: String(edited.message_id), text: edited.text ?? edited.caption, ...(edited.location ? { location: { latitude: edited.location.latitude, longitude: edited.location.longitude, livePeriod: edited.location.live_period } } : {}) })
    const reaction = u.message_reaction
    if (reaction?.chat?.id !== undefined && reaction.message_id !== undefined) lifecycle.push({ type: 'reaction', providerEventId: String(u.update_id), chatRef: String(reaction.chat.id), providerMessageId: String(reaction.message_id), emoji: reaction.new_reaction?.[0]?.emoji ?? '' })
    const chatId = u.message?.chat?.id
    const spec = u.message ? parseAttachment(u.message) : null
    // A message carries text, or an attachment with an optional caption, or both.
    const text = u.message?.text ?? (spec || u.message?.contact || u.message?.location || u.message?.venue ? u.message?.caption ?? '' : undefined)
    if (text != null && typeof chatId === 'number') {
      messages.push({
        providerEventId: String(u.update_id),
        ...(u.message?.message_id !== undefined ? { providerMessageId: String(u.message.message_id) } : {}),
        ...(u.message?.from?.id !== undefined ? { senderId: String(u.message.from.id) } : {}),
        ...(u.message?.message_thread_id !== undefined ? { topicId: String(u.message.message_thread_id) } : {}),
        chatRef: String(chatId),
        chatType: verifiedChatType(u.message?.chat?.type),
        chatId: String(chatId),
        from: u.message?.from?.username || u.message?.from?.first_name || u.message?.chat?.username,
        text,
        ...(u.message?.date ? { receivedAt: u.message.date * 1000 } : {}),
        ...(u.message?.reply_to_message?.message_id !== undefined ? { replyToMessageId: String(u.message.reply_to_message.message_id) } : {}),
        ...(u.message?.contact ? { contacts: [{ firstName: u.message.contact.first_name, lastName: u.message.contact.last_name, phone: u.message.contact.phone_number, vcard: u.message.contact.vcard }] } : {}),
        ...(u.message?.location ? { location: { latitude: u.message.location.latitude, longitude: u.message.location.longitude, livePeriod: u.message.location.live_period } } : u.message?.venue ? { location: { ...u.message.venue.location, name: u.message.venue.title, address: u.message.venue.address } } : {}),
        ...(spec ? { media: [{ provider: 'telegram' as const, mediaId: spec.fileId, kind: spec.kind, fileName: spec.fileName, mime: spec.mime, metadata: spec.metadata ?? { media: spec.kind === 'image' ? 'image' : 'file' } }] } : {}),
        ...(spec ? { attachmentSpecs: [spec] } : {})
      })
    }
    const cb = u.callback_query
    const cbChatId = cb?.message?.chat?.id
    if (cb?.data && typeof cbChatId === 'number') {
      messages.push({
        providerEventId: String(u.update_id),
        ...(cb.message?.message_id !== undefined ? { providerMessageId: String(cb.message.message_id) } : {}),
        ...(cb.from?.id !== undefined ? { senderId: String(cb.from.id) } : {}),
        ...(cb.message?.message_thread_id !== undefined ? { topicId: String(cb.message.message_thread_id) } : {}),
        chatRef: String(cbChatId),
        chatType: verifiedChatType(cb.message?.chat?.type),
        chatId: String(cbChatId),
        from: cb.from?.username || cb.from?.first_name || cb.message?.chat?.username,
        text: '',
        data: cb.data,
        callbackQueryId: cb.id, callbackMessageId: cb.message?.message_id !== undefined ? String(cb.message.message_id) : undefined
      })
      if (cb.id) callbackIds.push(cb.id)
    }
  }
  return { messages, nextOffset: Number.isFinite(maxId) ? maxId + 1 : null, callbackIds, lifecycle }
}

/** Allow-list check. An empty list rejects everything (the safe default). */
export function isAllowed(chatId: string, allowFrom: string[]): boolean {
  if (!allowFrom.length) return false
  return allowFrom.map((s) => s.trim()).includes(chatId)
}

export function toTelegramHtml(text: string): string {
  return formatTextParts(text, 'telegram', 32000).map(part => part.text).join('\n')
}

/** The Bot API endpoint + multipart field for a file, chosen by its extension. */
export function pickTelegramMethod(filePath: string): { method: string; field: string } {
  const ext = path.extname(filePath).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return { method: 'sendPhoto', field: 'photo' }
  if (['.mp3', '.m4a', '.ogg', '.oga', '.wav', '.flac', '.aac'].includes(ext)) return { method: 'sendAudio', field: 'audio' }
  if (['.mp4', '.mov', '.webm', '.mkv'].includes(ext)) return { method: 'sendVideo', field: 'video' }
  return { method: 'sendDocument', field: 'document' }
}

export function createTelegramChannel(id = 'telegram', name = 'Telegram'): MessagingChannel {
  let running = false
  let offset = 0
  let ctx: MessagingChannelContext | null = null
  let backoff = BACKOFF_BASE_MS
  // The last error surfaced to onError. We always keep channel.lastError fresh
  // (Settings reads it), but only emit to onError when the message *changes* —
  // a sustained outage logs once, not every poll cycle.
  let lastLoggedError: string | null = null
  let polling: AbortController | null = null
  let generation = 0
  let pendingLoop: Promise<void> | undefined
  let wakeBackoff: (() => void) | undefined

  function reportError(message: string): void {
    channel.connected = false
    channel.lastError = message
    if (message !== lastLoggedError) {
      lastLoggedError = message
      ctx?.onError(message)
    }
  }

  async function backoffSleep(): Promise<void> {
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { wakeBackoff = undefined; resolve() }, backoff)
      wakeBackoff = () => { clearTimeout(timer); wakeBackoff = undefined; resolve() }
    })
    backoff = nextBackoff(backoff)
  }

  async function loop(version: number): Promise<void> {
    const active = (): boolean => running && version === generation && ctx !== null
    while (active() && ctx) {
      const current = ctx
      const controller = new AbortController()
      polling = controller
      const abortTimer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS)
      try {
        const res = await telegramFetch(
          `${API}/bot${current.token}/getUpdates?timeout=25&offset=${offset}&allowed_updates=${encodeURIComponent(JSON.stringify(['message', 'edited_message', 'callback_query', 'message_reaction']))}`,
          withValleyCancellation({}, valleyCancellationOf(controller))
        )
        clearTimeout(abortTimer)
        if (!active()) break
        if (!res.ok) {
          reportError(t('assistant.backend.operationFailed', { operation: 'Telegram', status: res.status }))
          await backoffSleep()
          continue
        }
        const { messages, nextOffset, callbackIds, lifecycle } = parseUpdates(await res.json())
        if (!active()) break
        for (const event of lifecycle) if (active() && isAllowed(event.chatRef, current.allowFrom)) await current.onLifecycle?.(event)
        for (const m of messages) {
          if (!active()) break
          if (!isAllowed(m.chatId, current.allowFrom)) continue
          if (current.ingest) { await current.ingest(m); continue }
          // Download any attachment(s) and persist into the vault before dispatch,
          // so the agent turn carries vault paths, not raw bytes.
          const attachments: InboundAttachmentRef[] = []
          for (const spec of m.attachmentSpecs ?? []) {
            try {
              const bytes = await downloadTelegramFile(current.token, spec.fileId)
              if (!active()) break
              const savedPath = await current.saveInbound({ bytes, fileName: spec.fileName, chatRef: m.chatRef })
              attachments.push({ kind: spec.kind, id: savedPath.id, path: savedPath.path, fileName: spec.fileName, mime: spec.mime, metadata: spec.metadata })
            } catch (err) {
              throw new Error(t('assistant.backend.attachmentFailed', { value: err instanceof Error ? err.message : String(err) }))
            }
          }
          if (!active()) break
          await current.onMessage({ providerEventId: m.providerEventId, providerMessageId: m.providerMessageId, senderId: m.senderId, topicId: m.topicId, chatType: m.chatType, chatRef: m.chatRef, from: m.from, text: m.text, data: m.data, ...(attachments.length ? { attachments } : {}) })
        }
        for (const id of callbackIds) { if (!active()) break; await answerCallbackQuery(current.token, id) }
        if (nextOffset != null) offset = nextOffset
        // Recovered: clear the error and reset backoff so the next failure logs.
        if (!active()) break
        const changed = !channel.connected || Boolean(channel.lastError)
        channel.connected = true
        channel.lastError = undefined
        if (changed) current.onConnectionChange?.()
        lastLoggedError = null
        backoff = BACKOFF_BASE_MS
      } catch (err) {
        clearTimeout(abortTimer)
        if (!active()) break
        reportError(err instanceof Error ? err.message : String(err))
        await backoffSleep()
      }
    }
  }

  const channel: MessagingChannel = {
    id,
    type: 'telegram',
    displayName: name,
    running: false,
    connected: false,
    start(next): void {
      ctx = next
      if (running) return
      running = true
      channel.running = true
      channel.connected = false
      backoff = BACKOFF_BASE_MS
      lastLoggedError = null
      pendingLoop = loop(++generation)
    },
    stop(): Promise<void> {
      generation++
      running = false
      channel.running = false
      channel.connected = false
      ctx?.onConnectionChange?.()
      ctx = null
      polling?.abort()
      polling = null
      wakeBackoff?.()
      return pendingLoop ?? Promise.resolve()
    },
    async send(token, chatRef, text): Promise<void> {
      // Render the model's markdown as Telegram HTML; on a 400 (an entity Telegram
      // refuses), retry once as plain text so the message is never dropped.
      const post = (body: Record<string, unknown>): Promise<Response> =>
        telegramFetch(`${API}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
      const res = await post({ chat_id: chatRef, text: toTelegramHtml(text), parse_mode: 'HTML' })
      if (res.ok) return
      if (res.status === 400) {
        const plain = await post({ chat_id: chatRef, text })
        if (plain.ok) return
        throw new Error(t('assistant.backend.operationFailed', { operation: 'Telegram', status: plain.status }))
      }
      throw new Error(t('assistant.backend.operationFailed', { operation: 'Telegram', status: res.status }))
    },
    async sendButtons(token, chatRef, text, buttons): Promise<void> {
      // Chunk into rows of two so a richer approval set (allow/skip/remember…)
      // stays readable instead of one cramped row. Each `callback_data` is the
      // caller's short `<action>:<requestId>` value (kept < 64 bytes, C9).
      const rows: { text: string; callback_data: string }[][] = []
      for (let i = 0; i < buttons.length; i += 2) {
        rows.push(buttons.slice(i, i + 2).map((b) => ({ text: b.label, callback_data: b.value })))
      }
      const reply_markup = { inline_keyboard: rows }
      const post = (body: Record<string, unknown>): Promise<Response> =>
        telegramFetch(`${API}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatRef, reply_markup, ...body })
        })
      const res = await post({ text: toTelegramHtml(text), parse_mode: 'HTML' })
      if (res.ok) return
      if (res.status === 400) {
        const plain = await post({ text })
        if (plain.ok) return
        throw new Error(t('assistant.backend.operationFailed', { operation: 'Telegram', status: plain.status }))
      }
      throw new Error(t('assistant.backend.operationFailed', { operation: 'Telegram', status: res.status }))
    },
    async sendAttachment(token, chatRef, absPath, caption, config): Promise<void> {
      // Multipart upload of the local file. The endpoint + field are chosen by file
      // type (image→sendPhoto, audio→sendAudio, video→sendVideo, else sendDocument);
      // Node's global fetch/FormData/Blob handle the encoding and the filename lets
      // Telegram sniff the content type. The caption renders as MarkdownV2.
      const { method, field } = pickTelegramMethod(config?.attachment?.fileName ?? absPath)
      const fields: Record<string, string> = { chat_id: chatRef }
      if (caption) { fields.caption = toTelegramHtml(caption); fields.parse_mode = 'HTML' }
      const res = await uploadFile(`${API}/:token/${method}`, { handle: token, placement: 'path', name: 'token', prefix: 'bot' }, absPath, fields, field)
      if (!res.ok) throw new Error(t('assistant.backend.operationFailed', { operation: 'Telegram', status: res.status }))
    },
    async registerCommands(token, commands): Promise<void> {
      // Best-effort: a failed setMyCommands only leaves the native "/" menu stale,
      // never blocks start() or the poll loop.
      try {
        await telegramFetch(`${API}/bot${token}/setMyCommands`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ commands })
        })
      } catch {
        // ignore — see comment above
      }
    }
  }
  return channel
}

/**
 * Download a Telegram file by id: `getFile` yields a `file_path`, then the file is
 * fetched from the file endpoint. Returns the raw bytes for the manager to persist.
 */
export async function openTelegramFile(token: string, fileId: string, signal?: AbortSignal): Promise<Response> {
  const meta = await telegramFetch(`${API}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`, { signal })
  if (!meta.ok) throw new Error(t('assistant.backend.operationFailed', { operation: 'Telegram', status: meta.status }))
  const filePath = ((await meta.json()) as { result?: { file_path?: string } })?.result?.file_path
  if (typeof filePath !== 'string') throw new Error(t('assistant.backend.invalidMedia'))
  const file = await telegramFetch(`${API}/file/bot${token}/${filePath}`, { signal })
  if (!file.ok) throw new Error(t('assistant.backend.operationFailed', { operation: 'Telegram', status: file.status }))
  return file
}

export async function downloadTelegramFile(token: string, fileId: string, signal?: AbortSignal): Promise<Uint8Array> {
  return readBoundedMedia(await openTelegramFile(token, fileId, signal), 20 * 1024 * 1024, signal)
}

/** Ack a button tap so Telegram stops showing the inline button's spinner. */
async function answerCallbackQuery(token: string, callbackQueryId: string): Promise<void> {
  try {
    await telegramFetch(`${API}/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId })
    })
  } catch {
    // Best-effort: a failed ack only leaves the button spinning, never blocks.
  }
}
