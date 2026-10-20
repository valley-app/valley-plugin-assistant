import { AssistantRepository, record } from '../persistence/repositories'
import { runExclusive } from '../fileQueue'
import type { MessageDestination, MessageContent } from '../../contracts/channel'
import type { ChannelBus } from './bus'
import type { OutboundDelivery } from './deliveryQueue'
import { parseModelPickerCallback } from '../../channelCommands'
import type { Question } from './questionManager'

export interface PlanChannelAction {
  kind: 'plan.approve' | 'plan.refine'
  conversationId: string
  planId: string
  revision: number
  artifactHash: string
  instructionSnapshotId: string
}
export interface ChannelActor { channelId: string; chatRef: string; senderId: string; messageId?: string }
interface ActionHandle { id: string; action: PlanChannelAction; actor: ChannelActor; expiresAt: number; state: 'WAITING' | 'OPEN' | 'CONSUMED' }

export class ChannelActions {
  constructor(private repository: AssistantRepository) {}
  async issue(action: PlanChannelAction, actor: ChannelActor, awaitMessage = false): Promise<string> {
    const handle: ActionHandle = { id: `action:${crypto.randomUUID()}`, action, actor, expiresAt: Date.now() + 24 * 60 * 60 * 1000, state: awaitMessage ? 'WAITING' : 'OPEN' }
    await this.repository.data.transaction([{ dataset: 'channel_actions', operation: 'insert', values: record(handle.id, action.conversationId, handle.state, handle) }])
    return handle.id
  }
  async bindMessage(id: string, messageId: string): Promise<void> {
    if (!messageId) throw new Error('A provider message receipt is required for plan buttons')
    await runExclusive(`action:${id}`, async () => {
      const handle = await this.repository.get<ActionHandle>('channel_actions', id)
      if (!handle) throw new Error('Plan action is unavailable')
      if (handle.actor.messageId && handle.actor.messageId !== messageId) throw new Error('Plan action is already bound to another message')
      if (handle.state !== 'WAITING') return
      handle.actor.messageId = messageId; handle.state = 'OPEN'
      await this.repository.data.transaction([{ dataset: 'channel_actions', operation: 'upsert', values: record(id, handle.action.conversationId, handle.state, handle) }])
    })
  }
  async consume(id: string, actor: ChannelActor, run: (action: PlanChannelAction, actor: ChannelActor) => Promise<void>): Promise<boolean> {
    if (!id.startsWith('action:')) return false
    return runExclusive(`action:${id}`, async () => {
      const handle = await this.repository.get<ActionHandle>('channel_actions', id)
      if (!handle || handle.state !== 'OPEN' || handle.expiresAt <= Date.now()) return false
      if (await this.repository.get('conversation_deletions', handle.action.conversationId)) return false
      if (handle.actor.channelId !== actor.channelId || handle.actor.chatRef !== actor.chatRef || handle.actor.senderId !== actor.senderId || handle.actor.messageId && handle.actor.messageId !== actor.messageId) return false
      await run(handle.action, actor)
      handle.state = 'CONSUMED'
      await this.repository.data.transaction([{ dataset: 'channel_actions', operation: 'upsert', values: record(id, handle.action.conversationId, handle.state, handle) }])
      return true
    })
  }
}

interface ChoiceHandle { id: string; conversationId: string; value: string; questionId?: string; reply?: string; actor: ChannelActor; expiresAt: number; state: 'WAITING' | 'OPEN' | 'CONSUMED' }
interface ChoiceBundle { id: string; conversationId: string; kind: 'choices'; destination: MessageDestination; content: Extract<MessageContent, { type: 'buttons' | 'list' }>; state: 'WAITING' | 'BOUND' }

export class ChannelChoices {
  constructor(private repository: AssistantRepository) {}
  private persist(handle: ChoiceHandle) { return this.repository.data.transaction([{ dataset: 'channel_actions', operation: 'upsert', values: record(handle.id, handle.conversationId, handle.state, handle) }]) }
  async issue(conversationId: string, value: string, actor: ChannelActor, questionId?: string): Promise<string> {
    if (questionId) {
      const question = await this.repository.get<Question>('questions', questionId)
      if (!question || question.state !== 'OPEN' || question.expiresAt <= Date.now() || question.conversationId !== conversationId || question.connectionId !== actor.channelId || question.recipientId !== actor.senderId || !question.choices.some(choice => choice.value === value)) throw new Error('Question choice is unavailable')
    } else if (!parseModelPickerCallback(value)) throw new Error('Unsupported configuration choice')
    const handle: ChoiceHandle = { id: `choice:${crypto.randomUUID()}`, conversationId, value, questionId, actor, state: 'WAITING', expiresAt: Date.now() + 60 * 60 * 1000 }
    await this.persist(handle)
    return handle.id
  }
  /** A button the model sent: tapping it sends its label back as the user's own message, like typing it. */
  async issueReply(id: string, conversationId: string, value: string, reply: string, actor: ChannelActor): Promise<string> {
    if (await this.repository.get<ChoiceHandle>('channel_actions', id)) return id
    await this.persist({ id, conversationId, value, reply, actor, state: 'WAITING', expiresAt: Date.now() + 24 * 60 * 60 * 1000 })
    return id
  }
  async bind(id: string, messageId: string): Promise<void> {
    await runExclusive(`action:${id}`, async () => {
      const handle = await this.repository.get<ChoiceHandle>('channel_actions', id)
      if (!handle || !messageId) throw new Error('Configuration choice receipt is unavailable')
      if (handle.actor.messageId && handle.actor.messageId !== messageId) throw new Error('Choice belongs to another message')
      if (handle.state !== 'WAITING') return
      handle.actor.messageId = messageId; handle.state = 'OPEN'; await this.persist(handle)
    })
  }
  async consume(id: string, actor: ChannelActor, run: (value: string, questionId?: string, reply?: boolean) => Promise<void>): Promise<boolean> {
    if (!id.startsWith('choice:')) return false
    return runExclusive(`action:${id}`, async () => {
      const handle = await this.repository.get<ChoiceHandle>('channel_actions', id)
      if (!handle || handle.state !== 'OPEN' || handle.expiresAt <= Date.now() || handle.actor.channelId !== actor.channelId || handle.actor.chatRef !== actor.chatRef || handle.actor.senderId !== actor.senderId || !handle.actor.messageId || handle.actor.messageId !== actor.messageId) return false
      if (await this.repository.get('conversation_deletions', handle.conversationId)) return false
      if (handle.questionId) {
        const question = await this.repository.get<Question>('questions', handle.questionId)
        if (!question || question.state !== 'OPEN' || question.expiresAt <= Date.now() || question.conversationId !== handle.conversationId || question.connectionId !== actor.channelId || question.recipientId !== actor.senderId || !question.choices.some(choice => choice.value === handle.value)) return false
        await run(handle.value, handle.questionId)
      } else if (handle.reply !== undefined) await run(handle.reply, undefined, true)
      else await run(handle.value)
      handle.state = 'CONSUMED'; await this.persist(handle)
      return true
    })
  }
  async bindBundle(bundle: ChoiceBundle, receipt: OutboundDelivery): Promise<void> {
    if (bundle.state !== 'WAITING' || !['ACCEPTED', 'DELIVERED', 'READ'].includes(receipt.state) || receipt.providerMessageIds.length !== 1) return
    const values = bundle.content.type === 'buttons' ? bundle.content.choices.map(choice => choice.value) : bundle.content.sections.flatMap(section => section.rows.map(row => row.id))
    for (const value of values) await this.bind(value, receipt.providerMessageIds[0])
    bundle.state = 'BOUND'
    await this.repository.data.transaction([{ dataset: 'channel_replies', operation: 'upsert', values: record(bundle.id, bundle.conversationId, bundle.state, bundle) }])
  }
  async recover(): Promise<void> {
    for (const bundle of await this.repository.rows<ChoiceBundle>('channel_replies', { state: 'WAITING' })) {
      if (bundle.kind !== 'choices') continue
      const receipt = await this.repository.get<OutboundDelivery>('outbound_deliveries', bundle.id)
      if (receipt) await this.bindBundle(bundle, receipt)
    }
  }
}

export async function sendChannelChoices(repository: AssistantRepository, bus: Pick<ChannelBus, 'send'>, input: { id: string; destination: MessageDestination; senderId: string; text: string; choices: Array<{ label: string; value: string }>; questionId?: string }) {
  if (!input.destination.channelId || !input.destination.chatRef || !input.senderId) throw new Error('An authenticated channel recipient is required')
  const id = `choice-bundle:${input.id}`, handles = new ChannelChoices(repository)
  return runExclusive(`reply:${id}`, async () => {
    let bundle = await repository.get<ChoiceBundle>('channel_replies', id)
    if (!bundle) {
      const actor = { channelId: input.destination.channelId!, chatRef: input.destination.chatRef!, senderId: input.senderId }
      const choices: Array<{ label: string; value: string }> = []
      if (!input.choices.length || input.choices.length > (input.destination.kind === 'whatsapp' ? 10 : 20)) throw new Error('Too many choices for this channel')
      for (const choice of input.choices) choices.push({ label: choice.label, value: await handles.issue(input.destination.conversationId, choice.value, actor, input.questionId) })
      const content: ChoiceBundle['content'] = input.destination.kind === 'whatsapp' && choices.length > 3 ? { type: 'list', text: input.text, button: 'Choose answer', sections: [{ title: 'Answers', rows: choices.map(choice => ({ id: choice.value, title: [...choice.label].slice(0, 24).join('') })) }] } : { type: 'buttons', text: input.text, choices: choices.map(choice => ({ ...choice, label: input.destination.kind === 'whatsapp' ? [...choice.label].slice(0, 20).join('') : choice.label })) }
      bundle = { id, conversationId: input.destination.conversationId, destination: input.destination, content, kind: 'choices', state: 'WAITING' }
      await repository.data.transaction([{ dataset: 'channel_replies', operation: 'insert', values: record(id, bundle.conversationId, bundle.state, bundle) }])
    }
    const receipt = await bus.send({ id, conversationId: bundle.conversationId, destination: bundle.destination, content: bundle.content })
    await handles.bindBundle(bundle, receipt)
    return receipt
  })
}
