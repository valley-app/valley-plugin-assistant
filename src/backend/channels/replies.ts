import type { SessionSnapshot } from '../../contracts/execution'
import type { DeliveryReceipt, MessageContent, MessageDestination } from '../../contracts/channel'
import type { InboundAttachment } from '../../types'
import { speechSchema, type SpeechSettings } from '../configuration/schemas'
import { readSpeechSettings } from '../configuration/speech'
import { importAttachmentFile, referenceAttachments } from '../attachments'
import { AssistantRepository, record } from '../persistence/repositories'
import { backendApi, VAULT_ROOT } from '../runtime'
import { runExclusive } from '../fileQueue'
import { ChannelActions, ChannelChoices, sendChannelChoices } from './actions'
import type { Question } from './questionManager'
import type { ChannelBus } from './bus'
import { formatInline } from './formatting'

interface VoicePart {
  id: string
  text: string
  state: 'PENDING' | 'SYNTHESIZING' | 'READY' | 'UNKNOWN'
  attachment?: InboundAttachment
  error?: string
}
interface ReplyProjection {
  id: string
  conversationId: string
  destination: MessageDestination
  text: string
  speech: SpeechSettings
  voice: VoicePart[]
  state: 'READY'
}
interface ReviewProjection {
  id: string
  conversationId: string
  destination: MessageDestination
  content: Extract<MessageContent, { type: 'buttons' }>
  state: 'WAITING' | 'BOUND'
}
type SpeechFile = { handle: string; name: string; mimeType: string }
interface ReplyPorts {
  settings(): Promise<SpeechSettings>
  synthesize(input: { provider: 'elevenlabs' | 'openai'; connectionId?: string; model?: string; voice: string; text: string; format: 'opus'; requestId: string }): Promise<SpeechFile>
  importFile(input: Parameters<typeof importAttachmentFile>[0]): Promise<InboundAttachment>
  reference(conversationId: string, attachmentId: string): Promise<void>
  release(handle: string): Promise<unknown>
}
export interface ReplyDeliveryResult { receipts: DeliveryReceipt[]; errors: string[] }

function speechParts(source: string): string[] {
  const text = formatInline(source.replace(/```[\s\S]*?```/g, '\nCode is included in the text reply.\n'), 'whatsapp').replace(/[*_`~]/g, '').trim()
  const result: string[] = []
  let remaining = text
  while (remaining) {
    let length = Math.min(4096, remaining.length)
    if (length < remaining.length) {
      const boundary = Math.max(remaining.lastIndexOf('\n', length), remaining.lastIndexOf(' ', length))
      if (boundary > length / 2) length = boundary
      if (/^[\uDC00-\uDFFF]$/.test(remaining[length])) length--
    }
    const chunk = remaining.slice(0, length).trim()
    if (chunk) result.push(chunk)
    remaining = remaining.slice(length).trimStart()
  }
  return result
}

export class ChannelReplyService {
  private actions: ChannelActions
  private ports: ReplyPorts
  constructor(private repository: AssistantRepository, private bus: Pick<ChannelBus, 'send'>, ports: Partial<ReplyPorts> = {}) {
    this.actions = new ChannelActions(repository)
    this.ports = {
      settings: () => readSpeechSettings(VAULT_ROOT),
      synthesize: input => backendApi().ai.speech.synthesize(input),
      importFile: importAttachmentFile,
      reference: (conversationId, attachmentId) => referenceAttachments(conversationId, [{ role: 'assistant', content: '', attachmentIds: [attachmentId] }]),
      release: handle => backendApi().files.release([handle]),
      ...ports
    }
  }

  private persist(value: ReplyProjection | ReviewProjection) {
    return this.repository.data.transaction([{ dataset: 'channel_replies', operation: 'upsert', values: record(value.id, value.conversationId, value.state, value) }])
  }

  async recover(): Promise<void> {
    await new ChannelChoices(this.repository).recover()
    for (const reply of await this.repository.rows<ReplyProjection | ReviewProjection>('channel_replies')) {
      if (!('voice' in reply)) continue
      let changed = false
      for (const part of reply.voice) if (part.state === 'SYNTHESIZING') {
        part.state = 'UNKNOWN'; part.error = 'Speech synthesis was interrupted. Its billing outcome is unknown; it will not be repeated automatically.'; changed = true
      }
      if (changed) await this.persist(reply)
    }
  }

  async deliver(session: SessionSnapshot): Promise<ReplyDeliveryResult> {
    const result: ReplyDeliveryResult = { receipts: [], errors: [] }
    const thread = session.thread
    if (!thread?.channelId || !thread.chatRef || !['telegram', 'whatsapp'].includes(thread.source ?? '')) return result
    const lastIndex = [...thread.messages].reverse().findIndex(message => message.role === 'assistant' && Boolean(message.id && message.content && !message.toolCalls?.length && !message.error))
    const index = lastIndex < 0 ? -1 : thread.messages.length - 1 - lastIndex
    if (index < 0 || thread.messages.slice(index + 1).some(message => message.role === 'user')) return result
    const message = thread.messages[index], id = `reply:${thread.id}:${message.id}`
    if (message.channelDeliveryId) return result
    const destination: MessageDestination = { kind: thread.source!, conversationId: thread.id, channelId: thread.channelId, chatRef: thread.chatRef, ...(thread.channelChatType ? { chatType: thread.channelChatType } : {}), ...(thread.channelTopicId ? { topicId: thread.channelTopicId } : {}) }
    await runExclusive(`reply:${id}`, async () => {
      let reply = await this.repository.get<ReplyProjection>('channel_replies', id)
      if (!reply) {
        const user = thread.messages.slice(0, index).reverse().find(item => item.role === 'user')
        const voiceInput = user?.voiceInput || user?.attachmentFiles?.some(item => item.metadata?.media === 'voice')
        let speech = speechSchema.parse({ replyWithVoice: false })
        if (voiceInput) try { speech = await this.ports.settings() } catch (error) { result.errors.push(`Voice configuration is unavailable: ${String(error)}`) }
        reply = { id, conversationId: thread.id, destination, text: message.content, speech, voice: [], state: 'READY' }
        if (voiceInput && speech.replyWithVoice && speech.voiceId) reply.voice = speechParts(message.content).map((text, part) => ({ id: `voice:${thread.id}:${message.id}:${part}`, text, state: 'PENDING' }))
        if (voiceInput && speech.replyWithVoice && !speech.voiceId) result.errors.push('Voice reply is unavailable until a voice is selected in speech.md. The text reply is preserved.')
        await this.persist(reply)
      }
      if (message.id?.startsWith('quiz:')) for (const attachmentId of message.attachmentIds ?? []) {
        const receipt = await this.bus.send({ id: `question-image:${thread.id}:${message.id}:${attachmentId}`, conversationId: thread.id, destination: reply.destination, content: { type: 'attachment', attachmentId, media: 'image' } })
        result.receipts.push(receipt)
        if (receipt.error) result.errors.push(receipt.error)
        if (!['ACCEPTED', 'DELIVERED', 'READ'].includes(receipt.state)) return
      }
      const text = await this.bus.send({ id, conversationId: thread.id, destination: reply.destination, content: { type: 'text', text: reply.text } })
      result.receipts.push(text)
      if (text.error) result.errors.push(text.error)
      if (!['ACCEPTED', 'DELIVERED', 'READ'].includes(text.state)) return
      for (const part of reply.voice) {
        if (part.state === 'SYNTHESIZING') { part.state = 'UNKNOWN'; part.error = 'Speech synthesis outcome is unknown; automatic retry is blocked.'; await this.persist(reply) }
        if (part.state === 'UNKNOWN') { result.errors.push(part.error ?? 'Voice synthesis outcome is unknown'); break }
        if (part.state === 'PENDING') {
          part.state = 'SYNTHESIZING'; await this.persist(reply)
          let file: SpeechFile | undefined
          try {
            file = await this.ports.synthesize({ requestId: part.id, provider: reply.speech.provider, connectionId: reply.speech.connectionId, model: reply.speech.synthesisModel, voice: reply.speech.voiceId!, text: part.text, format: 'opus' })
            part.attachment = await this.ports.importFile({ fileHandle: file.handle, fileName: file.name, mime: file.mimeType, kind: 'audio' })
            if (!part.attachment.id) throw new Error('Synthesized audio has no durable attachment identity')
            await this.ports.reference(thread.id, part.attachment.id)
            part.state = 'READY'; await this.persist(reply)
          } catch (error) {
            part.state = 'UNKNOWN'; part.error = `Voice synthesis or persistence failed; billing may have occurred. Automatic retry is blocked: ${String(error)}`
            await this.persist(reply); result.errors.push(part.error); break
          } finally { if (file) await this.ports.release(file.handle).catch(() => undefined) }
        }
        const receipt = await this.bus.send({ id: part.id, conversationId: thread.id, destination: reply.destination, content: { type: 'attachment', attachmentId: part.attachment!.id, media: 'voice', metadata: { media: 'voice' } } })
        result.receipts.push(receipt)
        if (receipt.error) result.errors.push(receipt.error)
        if (!['ACCEPTED', 'DELIVERED', 'READ'].includes(receipt.state)) break
      }
    })
    if (thread.quiz?.source.startsWith('assistant-question:') && thread.channelSenderId && result.receipts.some(receipt => receipt.id === id && ['ACCEPTED', 'DELIVERED', 'READ'].includes(receipt.state))) {
      const question = await this.repository.get<Question>('questions', thread.quiz.source.slice('assistant-question:'.length))
      if (question?.state === 'OPEN' && question.choices.length && question.choices.length <= (destination.kind === 'whatsapp' ? 10 : 20)) {
        const receipt = await sendChannelChoices(this.repository, this.bus, { id: `question:${question.id}`, destination, senderId: question.recipientId, text: 'Choose your answer:', choices: question.choices, questionId: question.id })
        result.receipts.push(receipt)
        if (receipt.error) result.errors.push(receipt.error)
      }
    }
    const plan = thread.plan
    if (result.receipts.some(receipt => receipt.id === id && ['ACCEPTED', 'DELIVERED', 'READ'].includes(receipt.state)) && plan?.status === 'review' && plan.revision && plan.artifactHash && plan.instructionSnapshotId && thread.channelSenderId) {
      const reviewId = `plan-review:${thread.id}:${plan.id}:${plan.revision}`
      await runExclusive(`reply:${reviewId}`, async () => {
        let review = await this.repository.get<ReviewProjection>('channel_replies', reviewId)
        if (!review) {
          const actor = { channelId: thread.channelId!, chatRef: thread.chatRef!, senderId: thread.channelSenderId! }
          const binding = { conversationId: thread.id, planId: plan.id, revision: plan.revision!, artifactHash: plan.artifactHash!, instructionSnapshotId: plan.instructionSnapshotId! }
          const approve = await this.actions.issue({ ...binding, kind: 'plan.approve' }, actor, true)
          const refine = await this.actions.issue({ ...binding, kind: 'plan.refine' }, actor, true)
          review = { id: reviewId, conversationId: thread.id, destination, state: 'WAITING', content: { type: 'buttons', text: `Review plan revision ${plan.revision}.`, choices: [{ label: 'Yes, implement it', value: approve }, { label: 'Refine plan', value: refine }] } }
          await this.persist(review)
        }
        const receipt = await this.bus.send({ id: review.id, conversationId: thread.id, destination: review.destination, content: review.content })
        result.receipts.push(receipt)
        if (receipt.error) result.errors.push(receipt.error)
        if (review.state === 'WAITING' && ['ACCEPTED', 'DELIVERED', 'READ'].includes(receipt.state) && receipt.providerMessageIds.length === 1) {
          for (const choice of review.content.choices) await this.actions.bindMessage(choice.value, receipt.providerMessageIds[0])
          review.state = 'BOUND'; await this.persist(review)
        }
      })
    }
    return result
  }
}
