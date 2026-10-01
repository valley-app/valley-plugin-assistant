import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
type OwnerApi = PluginBackendOperationContext['api']
import { backendApi } from '../../../runtime'
import type { MessageContent, MessageDestination } from '../../../../contracts/channel'
import { telegramFetch, uploadFile } from '../../network'
import { DeliveryRejected } from '../../deliveryQueue'
import { resolveMedia, validateContent, channelCapabilities } from '../../capabilities'
import { formatInline } from '../../formatting'
import type { ChannelDispatchAttachment } from '../../mediaProbe'

async function receipt(response: Response): Promise<string[]> {
  const body = await response.json() as { ok?: boolean; description?: string; parameters?: { retry_after?: number }; result?: { message_id?: number } | boolean }
  if (!response.ok || body.ok === false) throw new DeliveryRejected(body.description ?? `Telegram rejected the request (${response.status})`, body.parameters?.retry_after ? body.parameters.retry_after * 1000 : undefined)
  if (body.ok !== true) throw new Error('Telegram returned an unrecognized response; delivery outcome is unknown')
  return typeof body.result === 'object' && body.result?.message_id !== undefined ? [String(body.result.message_id)] : []
}
export async function dispatchTelegram(token: string, destination: MessageDestination, content: MessageContent, attachment?: ChannelDispatchAttachment, api: OwnerApi = backendApi()): Promise<string[]> {
  validateContent(destination, content)
  const base = { chat_id: destination.chatRef, ...(destination.topicId ? { message_thread_id: Number(destination.topicId) } : {}), ...(destination.replyToMessageId ? { reply_parameters: { message_id: Number(destination.replyToMessageId) } } : {}) }
  let method: string, body: Record<string, unknown>
  if (content.type === 'text') { method = 'sendMessage'; body = { ...base, text: content.text, ...(content.format === 'telegramHtml' ? { parse_mode: 'HTML' } : {}) } }
  else if (content.type === 'buttons') {
    if (content.choices.some(choice => new TextEncoder().encode(choice.value).length > 64)) throw new DeliveryRejected('Telegram callback values are limited to 64 bytes')
    method = 'sendMessage'; body = { ...base, text: formatInline(content.text, 'telegram'), parse_mode: 'HTML', reply_markup: { inline_keyboard: content.choices.map(choice => [{ text: choice.label, callback_data: choice.value }]) } }
  } else if (content.type === 'keyboard') {
    method = 'sendMessage'
    const rows = content.rows.map(row => row.map(button => ({ text: button.label, ...('url' in button ? { url: button.url } : 'webApp' in button ? { web_app: { url: button.webApp } } : content.mode === 'reply' ? {} : { callback_data: button.value }) })))
    body = { ...base, text: formatInline(content.text, 'telegram'), parse_mode: 'HTML', reply_markup: content.remove ? { remove_keyboard: true } : content.mode === 'reply' ? { keyboard: rows, is_persistent: content.persistent ?? false, resize_keyboard: true } : { inline_keyboard: rows } }
  } else if (content.type === 'cta') { method = 'sendMessage'; body = { ...base, text: content.text, reply_markup: { inline_keyboard: [[{ text: content.label, url: content.url }]] } } }
  else if (content.type === 'contact') { method = 'sendContact'; body = { ...base, phone_number: content.contact.phone, first_name: content.contact.firstName, last_name: content.contact.lastName, vcard: content.contact.vcard } }
  else if (content.type === 'location') { method = content.name && content.address ? 'sendVenue' : 'sendLocation'; body = { ...base, latitude: content.latitude, longitude: content.longitude, ...(method === 'sendVenue' ? { title: content.name, address: content.address } : { live_period: content.livePeriod }) } }
  else if (content.type === 'poll') { method = 'sendPoll'; body = { ...base, question: content.question, options: content.options.map(text => ({ text })), allows_multiple_answers: content.multiple ?? false } }
  else if (content.type === 'reaction') { method = 'setMessageReaction'; body = { ...base, message_id: Number(content.messageId), reaction: [{ type: 'emoji', emoji: content.emoji }] } }
  else if (content.type === 'edit') { method = 'editMessageText'; body = { ...base, message_id: Number(content.messageId), text: content.text } }
  else if (content.type === 'delete') { method = 'deleteMessage'; body = { ...base, message_id: Number(content.messageId) } }
  else if (content.type === 'pin') { method = content.unpin ? 'unpinChatMessage' : 'pinChatMessage'; body = { chat_id: destination.chatRef, message_id: Number(content.messageId), disable_notification: content.silent ?? true } }
  else if (content.type === 'activity') { method = 'sendChatAction'; body = { ...base, action: content.action } }
  else if (content.type === 'attachment' && attachment) {
    const media = resolveMedia(content, attachment.mime)
    const field = { image: 'photo', audio: 'audio', voice: 'voice', video: 'video', file: 'document', videoNote: 'video_note', animation: 'animation', sticker: 'sticker' }[media]
    const method = { image: 'sendPhoto', audio: 'sendAudio', voice: 'sendVoice', video: 'sendVideo', file: 'sendDocument', videoNote: 'sendVideoNote', animation: 'sendAnimation', sticker: 'sendSticker' }[media]
    const reference = attachment.providerReference
    if (reference && reference.channelId === destination.channelId && reference.media === media) return receipt(await telegramFetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, [field]: reference.id, ...(content.caption ? { caption: content.caption, parse_mode: 'HTML' } : {}) }) }, api))
    const fields = Object.fromEntries(Object.entries({ ...base, ...(content.caption ? { caption: content.caption, parse_mode: 'HTML' } : {}), ...(content.metadata?.duration ? { duration: content.metadata.duration } : {}), ...(media === 'audio' ? { ...(content.title ? { title: content.title } : {}), ...(content.performer ? { performer: content.performer } : {}) } : {}) }).map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)]))
    return receipt(await uploadFile(`https://api.telegram.org/:token/${method}`, { handle: token, placement: 'path', name: 'token', prefix: 'bot' }, attachment.path, fields, field, { fileName: attachment.fileName, mimeType: attachment.mime, maxBytes: channelCapabilities.telegram.media![media]!.maxBytes }, api))
  } else throw new DeliveryRejected(`Telegram does not support ${content.type}`)
  return receipt(await telegramFetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, api))
}
