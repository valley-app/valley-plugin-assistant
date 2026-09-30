import type { ChannelCapabilities, ChannelKind, ChannelMediaKind, MessageContent, MessageDestination } from '../../contracts/channel'
import { DeliveryRejected } from './deliveryQueue'
const MB = 1024 * 1024
export const MAX_INGEST_BYTES = 32 * MB
export const channelCapabilities: Record<ChannelKind, ChannelCapabilities> = {
  chat: { kinds: ['text', 'attachment', 'contact', 'location', 'buttons', 'list'], maxAttachmentBytes: 32 * 1024 * 1024, maxButtons: 20, streamedText: true },
  telegram: {
    kinds: ['text', 'attachment', 'contact', 'location', 'buttons', 'keyboard', 'cta', 'poll', 'reaction', 'edit', 'delete', 'pin', 'activity'], maxAttachmentBytes: MAX_INGEST_BYTES, maxButtons: 100, maxTextLength: 4096, streamedText: false,
    media: {
      file: { maxBytes: 50 * MB, caption: true }, image: { maxBytes: 10 * MB, caption: true },
      audio: { maxBytes: 50 * MB, mimeTypes: ['audio/mpeg', 'audio/mp4'], caption: true },
      voice: { maxBytes: 50 * MB, mimeTypes: ['audio/ogg', 'audio/mpeg', 'audio/mp4'], caption: true },
      video: { maxBytes: 50 * MB, mimeTypes: ['video/mp4'], caption: true },
      videoNote: { maxBytes: 50 * MB, maxDuration: 60, mimeTypes: ['video/mp4'], caption: false },
      animation: { maxBytes: 50 * MB, mimeTypes: ['image/gif', 'video/mp4'], caption: true },
      sticker: { maxBytes: 512 * 1024, mimeTypes: ['image/webp', 'application/x-tgsticker', 'video/webm'], maxDuration: 3, caption: false }
    }, unavailable: { read: 'Telegram bots cannot issue general read receipts', list: 'Use an inline keyboard' }
  },
  whatsapp: {
    kinds: ['text', 'attachment', 'contact', 'location', 'buttons', 'list', 'cta', 'reaction', 'template', 'read', 'activity'], maxAttachmentBytes: MAX_INGEST_BYTES, maxButtons: 3, maxTextLength: 4096, streamedText: false,
    media: {
      file: { maxBytes: 100 * MB, caption: true }, image: { maxBytes: 5 * MB, mimeTypes: ['image/jpeg', 'image/png'], caption: true },
      audio: { maxBytes: 16 * MB, mimeTypes: ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'], caption: false },
      voice: { maxBytes: 16 * MB, mimeTypes: ['audio/ogg'], caption: false },
      video: { maxBytes: 16 * MB, mimeTypes: ['video/mp4', 'video/3gpp'], caption: true },
      sticker: { maxBytes: 500 * 1024, mimeTypes: ['image/webp'], caption: false }
    }, unavailable: { keyboard: 'WhatsApp has no persistent reply keyboard', pin: 'WhatsApp Cloud API cannot pin messages', edit: 'WhatsApp Cloud API cannot edit sent messages', delete: 'WhatsApp Cloud API cannot delete delivered messages', poll: 'Use reply buttons or a list' }
  }
}

export function resolveMedia(content: Extract<MessageContent, { type: 'attachment' }>, mime: string): ChannelMediaKind {
  if (content.uncompressed) return 'file'
  return content.media ?? (mime === 'image/gif' ? 'animation' : mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'file')
}

export function validateContent(destination: MessageDestination, content: MessageContent, attachment?: { mime: string; bytes: number }, configuredMaxBytes = MAX_INGEST_BYTES): void {
  const capabilities = channelCapabilities[destination.kind]
  const reject = (message: string): never => { throw new DeliveryRejected(message) }
  const length = (text: string, max: number, label: string) => { if (!text.trim() || text.length > max) reject(`${label} must contain 1–${max} characters`) }
  const url = (value: string) => { try { if (new URL(value).protocol !== 'https:') reject('Button URLs must use HTTPS') } catch { reject('Invalid button URL') } }
  if (!capabilities.kinds.includes(content.type)) reject(capabilities.unavailable?.[content.type] ?? `${destination.kind} does not support ${content.type}`)
  if (content.type === 'text') length(content.text, capabilities.maxTextLength ?? 32000, 'Text')
  if (content.type === 'buttons') {
    if (!content.choices.length || content.choices.length > capabilities.maxButtons) reject(`This channel supports 1–${capabilities.maxButtons} buttons`)
    const ids = new Set<string>()
    for (const choice of content.choices) {
      length(choice.label, destination.kind === 'whatsapp' ? 20 : 256, 'Button label')
      length(choice.value, destination.kind === 'whatsapp' ? 256 : 64, 'Button value')
      if (destination.kind === 'telegram' && new TextEncoder().encode(choice.value).length > 64) reject('Telegram callback values are limited to 64 UTF-8 bytes')
      if (ids.has(choice.value)) reject('Button values must be unique'); ids.add(choice.value)
    }
    length(content.text, destination.kind === 'whatsapp' ? 1024 : 4096, 'Button message')
  }
  if (content.type === 'keyboard') {
    if (content.mode === 'reply' && (!destination.chatType || destination.chatType === 'channel')) reject('Reply keyboards require a verified private or group chat')
    if (content.rows.flat().length > capabilities.maxButtons) reject('Too many keyboard buttons')
    for (const button of content.rows.flat()) {
      length(button.label, 256, 'Button label')
      if ('url' in button) url(button.url)
      if ('webApp' in button) { url(button.webApp); if (destination.chatType !== 'private') reject('Web App buttons require a verified private chat') }
      if ('value' in button && (new TextEncoder().encode(button.value).length > 64 || !button.value)) reject('Telegram callback values are limited to 1–64 UTF-8 bytes')
      if (content.mode === 'reply' && !('value' in button)) reject('Reply keyboard shortcuts must be text')
    }
  }
  if (content.type === 'list') {
    const rows = content.sections.flatMap(section => section.rows)
    if (!rows.length || rows.length > 10 || content.sections.length > 10) reject('WhatsApp lists support 1–10 rows in total')
    if (new Set(rows.map(row => row.id)).size !== rows.length) reject('List row IDs must be unique')
    length(content.text, 1024, 'List message'); length(content.button, 20, 'List button')
    for (const section of content.sections) { length(section.title, 24, 'Section title'); for (const row of section.rows) { length(row.id, 200, 'Row ID'); length(row.title, 24, 'Row title'); if (row.description) length(row.description, 72, 'Row description') } }
  }
  if (content.type === 'cta') { url(content.url); length(content.label, 20, 'CTA label'); length(content.text, 1024, 'CTA message') }
  if (content.type === 'location') {
    if (!Number.isFinite(content.latitude) || Math.abs(content.latitude) > 90 || !Number.isFinite(content.longitude) || Math.abs(content.longitude) > 180) reject('Invalid location coordinates')
    if (destination.kind === 'whatsapp' && content.livePeriod) reject('WhatsApp Cloud API does not support live location tracking')
  }
  if (content.type === 'activity' && destination.kind === 'whatsapp' && (content.action !== 'typing' || !content.messageId)) reject('WhatsApp typing requires an incoming message ID')
  if (content.type === 'attachment' && attachment) {
    const media = resolveMedia(content, attachment.mime), rule = capabilities.media?.[media]
    if (!rule && destination.kind !== 'chat') reject(`${destination.kind} does not support ${media}`)
    let limit = Math.min(configuredMaxBytes, rule?.maxBytes ?? configuredMaxBytes)
    if (media === 'sticker') limit = Math.min(limit, destination.kind === 'whatsapp' ? content.metadata?.animated ? 500 * 1024 : 100 * 1024 : attachment.mime === 'application/x-tgsticker' ? 64 * 1024 : attachment.mime === 'video/webm' ? 256 * 1024 : 512 * 1024)
    if (attachment.bytes > limit) reject(`Attachment exceeds the effective ${limit}-byte ${media} limit`)
    if (rule?.mimeTypes && !rule.mimeTypes.includes(attachment.mime.split(';')[0].trim())) reject(`${attachment.mime} cannot be sent as ${media} on ${destination.kind}`)
    if (content.caption && rule && !rule.caption) reject(`Send the ${media} caption as a separate text part`)
    if (content.metadata?.duration && rule?.maxDuration && content.metadata.duration > rule.maxDuration) reject(`${media} exceeds ${rule.maxDuration} seconds`)
    if (media === 'sticker' && content.metadata?.width && content.metadata?.height) {
      const { width, height } = content.metadata
      if (destination.kind === 'whatsapp' ? width !== 512 || height !== 512 : Math.max(width, height) !== 512 || Math.min(width, height) > 512) reject('Sticker dimensions are not supported')
    }
  }
}
