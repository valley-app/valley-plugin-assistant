import { z } from 'zod'
import type { MessageContent, MessageDestination, ChannelMediaMetadata } from '../../contracts/channel'
import type { ToolExecutionContext } from '../../contracts/tools'
import type { ToolRegistry } from '../tools/registry'
import type { ChannelBus } from './bus'
import { validateContent } from './capabilities'
import { listConversationAttachments } from '../attachments'
import { channelManager } from './manager'
import { VAULT_ROOT } from '../runtime'
import { ChannelChoices } from './actions'
import { contentHash } from '../configuration/markdown'
import type { AssistantRepository } from '../persistence/repositories'

/**
 * Buttons the model sends carry bound reply handles instead of its raw values, so a tap comes back as the button's
 * label from the same sender, exactly as if they had typed it. Handle IDs derive from the delivery so a retried send
 * reuses them.
 */
async function bindModelButtons(repository: AssistantRepository, deliveryId: string, destination: MessageDestination, senderId: string, content: MessageContent): Promise<{ content: MessageContent; handles: string[] }> {
  const choices = new ChannelChoices(repository), handles: string[] = [], actor = { channelId: destination.channelId!, chatRef: destination.chatRef!, senderId }
  const handle = async (value: string, label: string) => {
    const id = await choices.issueReply(`choice:${contentHash(`${deliveryId}:${handles.length}`).slice(0, 32)}`, destination.conversationId, value, label, actor)
    handles.push(id); return id
  }
  if (content.type === 'buttons') {
    const bound = []
    for (const choice of content.choices) bound.push({ ...choice, value: await handle(choice.value, choice.label) })
    return { content: { ...content, choices: bound }, handles }
  }
  if (content.type === 'list') {
    const sections = []
    for (const section of content.sections) { const rows = []; for (const row of section.rows) rows.push({ ...row, id: await handle(row.id, row.title) }); sections.push({ ...section, rows }) }
    return { content: { ...content, sections }, handles }
  }
  if (content.type === 'keyboard' && content.mode !== 'reply') {
    const rows = []
    for (const row of content.rows) { const bound = []; for (const button of row) bound.push('value' in button ? { ...button, value: await handle(button.value, button.label) } : button); rows.push(bound) }
    return { content: { ...content, rows }, handles }
  }
  return { content, handles }
}

const text = z.string().max(32000)
const id = z.string().min(1).max(256)
const choice = z.object({ label: z.string().min(1).max(256), value: id }).strict()
const keyboardButton = z.union([choice, z.object({ label: id, url: z.string().url() }).strict(), z.object({ label: id, webApp: z.string().url() }).strict()])
const mediaMetadata = z.object({ media: z.enum(['file', 'image', 'audio', 'voice', 'video', 'videoNote', 'animation', 'sticker']), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), duration: z.number().nonnegative().optional(), animated: z.boolean().optional(), video: z.boolean().optional() }).strict()
export const channelContentSchema: z.ZodType<MessageContent> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text }).strict(),
  z.object({ type: z.literal('attachment'), attachmentId: id, media: mediaMetadata.shape.media.optional(), caption: text.optional(), metadata: mediaMetadata.optional(), title: id.optional(), performer: id.optional(), uncompressed: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('contact'), contact: z.object({ firstName: id, lastName: id.optional(), phone: id, email: z.string().email().optional(), organization: id.optional(), vcard: z.string().max(2048).optional() }).strict() }).strict(),
  z.object({ type: z.literal('location'), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), name: id.optional(), address: text.optional(), livePeriod: z.number().int().positive().optional() }).strict(),
  z.object({ type: z.literal('buttons'), text, choices: z.array(choice).min(1).max(100) }).strict(),
  z.object({ type: z.literal('keyboard'), text, rows: z.array(z.array(keyboardButton).max(8)).max(20), mode: z.enum(['inline', 'reply']).optional(), persistent: z.boolean().optional(), remove: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('cta'), text, label: id, url: z.string().url() }).strict(),
  z.object({ type: z.literal('list'), text, button: id, sections: z.array(z.object({ title: id, rows: z.array(z.object({ id, title: id, description: text.optional() }).strict()).max(10) }).strict()).max(10) }).strict(),
  z.object({ type: z.literal('poll'), question: id, options: z.array(id).min(2).max(12), multiple: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('reaction'), messageId: id, emoji: z.string().max(64) }).strict(),
  z.object({ type: z.literal('edit'), messageId: id, text }).strict(),
  z.object({ type: z.literal('delete'), messageId: id }).strict(),
  z.object({ type: z.literal('pin'), messageId: id, silent: z.boolean().optional(), unpin: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('read'), messageId: id }).strict(),
  z.object({ type: z.literal('activity'), action: z.enum(['typing', 'upload_photo', 'upload_video', 'upload_voice', 'upload_document', 'choose_sticker']), messageId: id.optional() }).strict(),
  z.object({ type: z.literal('template'), name: id, language: id, parameters: z.array(text).max(50), buttons: z.array(z.object({ type: z.enum(['url', 'quick_reply']), index: z.number().int().min(0).max(9), value: id }).strict()).max(10).optional() }).strict()
])

export function stickerCapabilities(input: { mime: string; metadata?: ChannelMediaMetadata; visionAvailable: boolean; animationDecoderAvailable?: boolean }) {
  const staticImage = input.mime === 'image/webp' && !input.metadata?.animated
  const animated = input.metadata?.animated || input.mime === 'application/x-tgsticker' || input.mime === 'video/webm'
  const preview = staticImage || Boolean(animated && input.animationDecoderAvailable)
  return {
    receive: true, preserveOriginal: true, preview,
    interpret: preview && input.visionAvailable,
    interpretation: preview && input.visionAvailable ? 'available' : 'unavailable',
    reason: !preview ? 'A compatible animation decoder is unavailable; retain the original and use an available thumbnail.' : !input.visionAvailable ? 'No vision provider is configured.' : undefined,
    send: { telegram: ['image/webp', 'application/x-tgsticker', 'video/webm'].includes(input.mime), whatsapp: input.mime === 'image/webp' }
  }
}

export function registerChannelTools(registry: ToolRegistry, bus: ChannelBus, options: {
  destination?: MessageDestination
  senderId?: string
  repository?: AssistantRepository
  planning: boolean
  automaticReply?: boolean
  authorizeExternal?: (context: ToolExecutionContext, input: { destination: MessageDestination; content: MessageContent }) => Promise<unknown>
  stickerMetadata?: (attachmentId: string) => Promise<ChannelMediaMetadata | undefined> | ChannelMediaMetadata | undefined
  inspectSticker?: (attachmentId: string, context: ToolExecutionContext) => Promise<unknown>
}): void {
  registry.register({ name: 'channel_capabilities', description: 'Inspect current connection and recipient availability, supported messaging payloads, effective media limits, and unavailable actions. Sticker reception, preview, interpretation, and sending are separate capabilities.', group: 'messaging', parameters: z.object({}).strict(), output: z.unknown(), requiredCapabilities: [], timeoutMs: 10000, effect: 'read', guardTargets: () => [{ kind: 'tool', id: 'channel_capabilities', sideEffect: 'read' }], execute: async (_input, context) => options.destination ? { destination: options.destination, ...await channelManager.operationDescriptors(VAULT_ROOT, options.destination, context.operation.api), stickerInterpretation: options.inspectSticker ? { available: true, formats: ['image/webp'], animated: false } : { available: false, reason: 'No configured vision provider and compatible parser are available' } } : { available: false, reason: 'This conversation has no remote messaging destination.' } })
  registry.register({ name: 'channel_send', description: 'Send media or perform a supported action in this conversation’s bound messaging channel. Ordinary text replies are delivered automatically: write them as the final answer, without a delivery confirmation. Discover capabilities first. Attachments require an existing conversation attachment ID; a stable deliveryKey prevents duplicate delivery. Never use an action callback to approve a plan.', group: 'messaging', parameters: z.object({ deliveryKey: id, content: channelContentSchema }).strict(), output: z.unknown(), requiredCapabilities: [], timeoutMs: 120000, effect: 'non-idempotent', guardTargets: () => [], execute: async (input, context) => {
    if (options.planning || context.planning) throw new Error('Plan mode forbids channel side effects')
    context.operation.cancellation.throwIfAborted()
    if (!options.destination || options.destination.conversationId !== context.conversationId) throw new Error('A trusted destination for this conversation is required')
    if (options.automaticReply && input.content.type === 'text') return { delivery: 'automatic', instruction: 'No message was sent by this tool. Return the requested text as your final answer; it will be delivered once. Do not add delivery status, IDs or a confirmation.' }
    if (input.content.type !== 'text' && input.content.type !== 'attachment') {
      try { validateContent(options.destination, input.content) }
      catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { outcome: 'not-applied' }) }
    }
    if (!options.authorizeExternal) throw new Error('Channel sends require the core command broker authorization')
    await options.authorizeExternal(context, { destination: options.destination, content: input.content })
    context.operation.cancellation.throwIfAborted()
    const deliveryId = `tool:${context.runId}:${input.deliveryKey}`
    if (!options.repository || !options.senderId || !options.destination.channelId || !options.destination.chatRef) return bus.send({ id: deliveryId, conversationId: context.conversationId, destination: options.destination, content: input.content })
    const bound = await bindModelButtons(options.repository, deliveryId, options.destination, options.senderId, input.content)
    const receipt = await bus.send({ id: deliveryId, conversationId: context.conversationId, destination: options.destination, content: bound.content })
    if (bound.handles.length && ['ACCEPTED', 'DELIVERED', 'READ'].includes(receipt.state) && receipt.providerMessageIds.length === 1) {
      const choices = new ChannelChoices(options.repository)
      for (const id of bound.handles) await choices.bind(id, receipt.providerMessageIds[0])
    }
    return receipt
  } })
  registry.register({ name: 'channel_inspect_sticker', description: 'Check whether an existing sticker can be previewed, interpreted, or sent. Preserve the original when vision or animation decoding is unavailable.', group: 'messaging', parameters: z.object({ attachmentId: id }).strict(), output: z.unknown(), requiredCapabilities: [], timeoutMs: 60000, effect: 'read', guardTargets: () => [{ kind: 'tool', id: 'channel_inspect_sticker', sideEffect: 'read' }], execute: async (input, context) => {
    const found = (await listConversationAttachments(context.conversationId, context.operation.api)).find(attachment => attachment.id === input.attachmentId)
    if (!found) throw new Error('Sticker is unavailable to this conversation')
    const capabilities = stickerCapabilities({ mime: found.mime, metadata: await options.stickerMetadata?.(found.id), visionAvailable: Boolean(options.inspectSticker) })
    if (!capabilities.interpret) return { attachmentId: found.id, fileName: found.fileName, ...capabilities }
    return { attachmentId: found.id, fileName: found.fileName, ...capabilities, result: await options.inspectSticker!(found.id, context) }
  } })
}
