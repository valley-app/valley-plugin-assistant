export type ChannelKind = 'chat' | 'telegram' | 'whatsapp'
export interface MessageDestination {
  kind: ChannelKind
  conversationId: string
  channelId?: string
  chatRef?: string
  topicId?: string
  chatType?: 'private' | 'group' | 'supergroup' | 'channel'
  replyToMessageId?: string
}
export interface ContactCard {
  firstName: string
  lastName?: string
  phone: string
  email?: string
  organization?: string
  vcard?: string
}
export type ChannelMediaKind = 'file' | 'image' | 'audio' | 'voice' | 'video' | 'videoNote' | 'animation' | 'sticker'
export interface ChannelMediaMetadata {
  media: ChannelMediaKind
  providerFileId?: string
  providerUniqueId?: string
  bytes?: number
  width?: number
  height?: number
  duration?: number
  animated?: boolean
  video?: boolean
  emoji?: string
  stickerSet?: string
  thumbnailFileId?: string
  interpretation?: 'pending' | 'complete' | 'partial' | 'unavailable'
}
export type ChannelKeyboardButton = { label: string; value: string } | { label: string; url: string } | { label: string; webApp: string }
export type MessageContent =
  | { type: 'text'; text: string; format?: 'telegramHtml' | 'whatsapp' | 'plain' }
  | { type: 'attachment'; attachmentId?: string; path?: string; media?: ChannelMediaKind; caption?: string; metadata?: ChannelMediaMetadata; title?: string; performer?: string; uncompressed?: boolean }
  | { type: 'contact'; contact: ContactCard }
  | { type: 'location'; latitude: number; longitude: number; name?: string; address?: string; livePeriod?: number }
  | { type: 'buttons'; text: string; choices: Array<{ label: string; value: string }> }
  | { type: 'list'; text: string; button: string; sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }> }
  | { type: 'poll'; question: string; options: string[]; multiple?: boolean }
  | { type: 'keyboard'; text: string; rows: ChannelKeyboardButton[][]; mode?: 'inline' | 'reply'; persistent?: boolean; remove?: boolean }
  | { type: 'cta'; text: string; label: string; url: string }
  | { type: 'reaction'; messageId: string; emoji: string }
  | { type: 'edit'; messageId: string; text: string }
  | { type: 'delete'; messageId: string }
  | { type: 'pin'; messageId: string; silent?: boolean; unpin?: boolean }
  | { type: 'read'; messageId: string }
  | { type: 'activity'; action: 'typing' | 'upload_photo' | 'upload_video' | 'upload_voice' | 'upload_document' | 'choose_sticker'; messageId?: string }
  | { type: 'template'; name: string; language: string; parameters: string[]; buttons?: Array<{ type: 'url' | 'quick_reply'; index: number; value: string }> }
export type DeliveryState = 'PENDING' | 'DISPATCHING' | 'ACCEPTED' | 'DELIVERED' | 'READ' | 'FAILED' | 'UNKNOWN'
export interface DeliveryReceipt {
  id: string
  state: DeliveryState
  providerMessageIds: string[]
  error?: string
}
export interface ChannelCapabilities {
  kinds: MessageContent['type'][]
  maxAttachmentBytes: number
  maxButtons: number
  streamedText: boolean
  maxTextLength?: number
  media?: Partial<Record<ChannelMediaKind, { maxBytes: number; mimeTypes?: string[]; maxDuration?: number; caption: boolean }>>
  unavailable?: Partial<Record<MessageContent['type'], string>>
}
