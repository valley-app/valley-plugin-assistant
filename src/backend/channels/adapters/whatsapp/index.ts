import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
type OwnerApi = PluginBackendOperationContext['api']
import { backendApi } from '../../../runtime'
import type { MessageContent, MessageDestination } from '../../../../contracts/channel'
import { whatsappFetch, uploadFile } from '../../network'
import { DeliveryRejected } from '../../deliveryQueue'
import type { ChannelRuntimeConfig } from '../../types'
import { normalizeGraphVersion } from '../../whatsapp'
import { channelCapabilities, resolveMedia, validateContent } from '../../capabilities'
import { formatInline } from '../../formatting'
import type { ChannelDispatchAttachment } from '../../mediaProbe'

export async function dispatchWhatsApp(token: string, config: ChannelRuntimeConfig, destination: MessageDestination, content: MessageContent, attachment?: ChannelDispatchAttachment, api: OwnerApi = backendApi()): Promise<string[]> {
  validateContent(destination, content)
  if (!config.phoneNumberId) throw new DeliveryRejected('WhatsApp phone number is not configured')
  const endpoint = `https://graph.facebook.com/${normalizeGraphVersion(config.graphVersion)}/${config.phoneNumberId}`
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: destination.chatRef, ...(destination.replyToMessageId ? { context: { message_id: destination.replyToMessageId } } : {}) }
  let body: Record<string, unknown>
  if (content.type === 'text') body = { ...base, type: 'text', text: { body: content.text } }
  else if (content.type === 'buttons') {
    if (content.choices.length > 3) throw new DeliveryRejected('WhatsApp supports at most three reply buttons')
    body = { ...base, type: 'interactive', interactive: { type: 'button', body: { text: formatInline(content.text, 'whatsapp') }, action: { buttons: content.choices.map(choice => ({ type: 'reply', reply: { id: choice.value, title: choice.label } })) } } }
  } else if (content.type === 'list') body = { ...base, type: 'interactive', interactive: { type: 'list', body: { text: content.text }, action: { button: content.button, sections: content.sections } } }
  else if (content.type === 'contact') body = { ...base, type: 'contacts', contacts: [{ name: { formatted_name: [content.contact.firstName, content.contact.lastName].filter(Boolean).join(' '), first_name: content.contact.firstName, last_name: content.contact.lastName }, phones: [{ phone: content.contact.phone }], ...(content.contact.email ? { emails: [{ email: content.contact.email }] } : {}), ...(content.contact.organization ? { org: { company: content.contact.organization } } : {}) }] }
  else if (content.type === 'location') body = { ...base, type: 'location', location: { latitude: content.latitude, longitude: content.longitude, name: content.name, address: content.address } }
  else if (content.type === 'reaction') body = { ...base, type: 'reaction', reaction: { message_id: content.messageId, emoji: content.emoji } }
  else if (content.type === 'cta') body = { ...base, type: 'interactive', interactive: { type: 'cta_url', body: { text: content.text }, action: { name: 'cta_url', parameters: { display_text: content.label, url: content.url } } } }
  else if (content.type === 'read' || content.type === 'activity') body = { messaging_product: 'whatsapp', status: 'read', message_id: content.messageId, ...(content.type === 'activity' ? { typing_indicator: { type: 'text' } } : {}) }
  else if (content.type === 'template') body = { ...base, type: 'template', template: { name: content.name, language: { code: content.language }, components: [...(content.parameters.length ? [{ type: 'body', parameters: content.parameters.map(text => ({ type: 'text', text })) }] : []), ...(content.buttons ?? []).map(button => ({ type: 'button', sub_type: button.type, index: String(button.index), parameters: [button.type === 'url' ? { type: 'text', text: button.value } : { type: 'payload', payload: button.value }] }))] } }
  else if (content.type === 'attachment' && attachment) {
    const media = resolveMedia(content, attachment.mime)
    const type = media === 'file' ? 'document' : media === 'voice' ? 'audio' : media
    if (type === 'audio' && content.caption) throw new DeliveryRejected('Send an audio caption as a separate text message')
    const rule = channelCapabilities.whatsapp.media?.[media]
    if (!rule) throw new DeliveryRejected(`WhatsApp does not support ${media}`)
    let mediaId: string | undefined
    const reference = attachment.providerReference
    if (reference && reference.channelId === destination.channelId && reference.media === media) {
      let existing: Response
      try { existing = await whatsappFetch(`https://graph.facebook.com/${normalizeGraphVersion(config.graphVersion)}/${encodeURIComponent(reference.id)}`, { headers: { authorization: `Bearer ${token}` } }, api) }
      catch { throw new DeliveryRejected('Could not verify the original WhatsApp media reference; no message was sent') }
      await existing.body?.cancel()
      if (existing.ok) mediaId = reference.id
      else if (![400, 404, 410].includes(existing.status)) throw new DeliveryRejected(`WhatsApp media verification failed (${existing.status}); no message was sent`)
    }
    if (!mediaId) {
      const upload = await uploadFile(`${endpoint}/media`, { handle: token, placement: 'header', name: 'Authorization', prefix: 'Bearer ' }, attachment.path, { messaging_product: 'whatsapp', type: attachment.mime }, 'file', { fileName: attachment.fileName, mimeType: attachment.mime, maxBytes: rule.maxBytes }, api)
      if (!upload.ok) throw new DeliveryRejected(`WhatsApp media upload failed (${upload.status})`)
      mediaId = (await upload.json() as { id?: string }).id
    }
    if (!mediaId) throw new DeliveryRejected('WhatsApp returned no media identifier')
    body = { ...base, type, [type]: { id: mediaId, ...(content.caption ? { caption: content.caption } : {}), ...(type === 'document' ? { filename: attachment.fileName } : {}), ...(media === 'voice' ? { voice: true } : {}) } }
  } else throw new DeliveryRejected(`WhatsApp does not support ${content.type}`)
  const response = await whatsappFetch(`${endpoint}/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }, api)
  const result = await response.json() as { messages?: Array<{ id: string }>; success?: boolean; error?: { message?: string } }
  if (!response.ok || result.error) throw new DeliveryRejected(result.error?.message ?? `WhatsApp rejected the request (${response.status})`)
  if ((content.type === 'read' || content.type === 'activity') && result.success === true) return []
  if (!result.messages?.length) throw new Error('WhatsApp returned no message receipt; delivery outcome is unknown')
  return result.messages.map(message => message.id)
}
