import { describe, expect, it, vi } from 'vitest'
import type { AiChatRequest, AiChatThread, ChannelMessage } from '../src/types'
import type { RuntimeHooks } from '../src/backend/runtimes'
import { channelFixture, createBackendChannelFixture } from './backendChannelFixture'
import { ChannelActions, ChannelChoices, sendChannelChoices } from '../src/backend/channels/actions'
import { ChannelReplyService } from '../src/backend/channels/replies'
import { conversationAttachmentMetadata, importAttachmentFile, listConversationAttachments } from '../src/backend/attachments'

const inbound = (text: string, id: string, extra: Partial<ChannelMessage> = {}): ChannelMessage => ({ channelId: 'telegram', chatRef: '123', senderId: 'sender', providerEventId: id, providerMessageId: id, text, ts: Date.now(), ...extra })
const idle = async (runtime: ReturnType<typeof createBackendChannelFixture>['runtime'], id: string) => {
  await vi.waitFor(() => expect(runtime.coordinator.snapshot(id)?.state).toBe('IDLE'))
  await vi.waitFor(() => expect(channelFixture.threads.get(id)?.messages.at(-1)?.role).toBe('assistant'))
}

describe('backend channel interactions', () => {
  it('delivers an ordinary answer once even if the model tries to send it as a tool', async () => {
    const { runtime } = createBackendChannelFixture()
    channelFixture.infer.mockImplementationOnce(async (_input: unknown, _context: unknown, hooks: RuntimeHooks) => {
      const result = JSON.parse(await hooks.tool({ id: 'answer', name: 'channel_send', arguments: { deliveryKey: 'answer', content: { type: 'text', text: 'Four.' } } }))
      expect(result).toMatchObject({ success: true, value: { delivery: 'automatic' } })
      expect(channelFixture.dispatch).not.toHaveBeenCalled()
      hooks.event({ type: 'message', message: { role: 'assistant', content: 'Four.' } })
    })
    const accepted = await runtime.inbound('telegram', inbound('What is two plus two?', 'sum'))
    await idle(runtime, accepted.conversationId)
    await vi.waitFor(() => expect(channelFixture.dispatch).toHaveBeenCalledOnce())
    expect(channelFixture.dispatch.mock.calls[0][1]).toMatchObject({ type: 'text', text: 'Four.' })
  })

  it('imports a generated document, discovers its durable reference, and sends the preserved original', async () => {
    const { runtime, api } = createBackendChannelFixture()
    const document = { id: '6944b2e6-9c5c-423e-8755-f1c0a13774c9', path: '.valley/plugins/data/assistant/attachment/report', fileName: 'Mechanik Lösung.pdf', mime: 'application/pdf', kind: 'pdf' as const, owned: true, sha256: 'hash', state: 'ready', createdAt: 1 }
    vi.mocked(importAttachmentFile).mockResolvedValueOnce(document)
    vi.mocked(listConversationAttachments).mockResolvedValue([document])
    vi.mocked(conversationAttachmentMetadata).mockResolvedValue({ attachment: document, bytes: 1024 })
    vi.mocked(api.agent.invoke).mockImplementation(async (_scope, command) => command === 'projects.openFile' ? { handle: 'original-pdf', name: document.fileName, size: 1024 } : { authorized: true })
    channelFixture.infer.mockImplementationOnce(async (_input: unknown, _context: unknown, hooks: RuntimeHooks) => {
      const imported = JSON.parse(await hooks.tool({ id: 'import-document', name: 'attachment_import', arguments: { path: 'generated/Mechanik Lösung.pdf' } }))
      expect(imported).toMatchObject({ success: true, value: { id: document.id, fileName: document.fileName, mime: 'application/pdf' } })
      expect(channelFixture.dispatch).not.toHaveBeenCalled()
      const listed = JSON.parse(await hooks.tool({ id: 'list-document', name: 'attachment_list', arguments: {} }))
      expect(listed.value).toContainEqual({ id: document.id, fileName: document.fileName, mime: 'application/pdf', kind: 'pdf', bytes: 1024 })
      const sent = JSON.parse(await hooks.tool({ id: 'send-document', name: 'channel_send', arguments: { deliveryKey: 'generated-report', content: { type: 'attachment', attachmentId: document.id, media: 'file' } } }))
      expect(sent).toMatchObject({ success: true, value: { state: 'ACCEPTED' } })
    })
    const first = await runtime.inbound('telegram', inbound('Send my generated PDF', 'generated-report'))
    await vi.waitFor(() => expect(runtime.coordinator.snapshot(first.conversationId)?.state).toBe('IDLE'))
    expect(channelFixture.dispatch).toHaveBeenCalledOnce()
    expect(channelFixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ conversationId: first.conversationId }), expect.objectContaining({ type: 'attachment', attachmentId: document.id }), { path: `/vault/${document.path}`, fileName: document.fileName, mime: 'application/pdf' }, api)
    expect(api.files.release).toHaveBeenCalledWith(['original-pdf'])
    expect(api.agent.invoke).toHaveBeenCalledWith('scope', 'authorize.external', expect.objectContaining({ target: { kind: 'tool', id: 'channel.attachment_import', sideEffect: 'write' } }))
  })

  it.each(['private', 'supergroup', undefined] as const)('binds provider chat type %s to guarded Web App keyboard dispatch', async chatType => {
    const { runtime, api } = createBackendChannelFixture()
    let result = ''
    channelFixture.infer.mockImplementationOnce(async (_input: unknown, _context: unknown, hooks: RuntimeHooks) => { result = await hooks.tool({ id: 'keyboard-call', name: 'channel_send', arguments: { deliveryKey: 'web-app', content: { type: 'keyboard', text: 'Open the exercise', rows: [[{ label: 'Exercise', webApp: 'https://example.com/exercise' }]] } } }) })
    const first = await runtime.inbound('telegram', inbound('Open an exercise', `web-app-${chatType}`, { chatType }))
    await vi.waitFor(() => expect(runtime.coordinator.snapshot(first.conversationId)?.state).toBe('IDLE'))
    expect(runtime.coordinator.snapshot(first.conversationId)?.thread?.channelChatType).toBe(chatType)
    if (chatType === 'private') {
      expect(result).toContain('ACCEPTED')
      expect(channelFixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ chatType: 'private' }), expect.objectContaining({ type: 'keyboard' }), undefined, api)
    } else { expect(result).toContain('verified private chat'); expect(JSON.parse(result)).toMatchObject({ success: false, error: { recoverable: true } }); expect(JSON.parse(result).error.outcomeUnknown).toBeUndefined(); expect(channelFixture.dispatch).not.toHaveBeenCalled() }
  })

  it('queues messages during a run and preserves shared history and each turn sender', async () => {
    const { runtime } = createBackendChannelFixture(), releases: Array<() => void> = []
    const counts: number[] = [], senders: Array<string | undefined> = []
    channelFixture.infer.mockImplementation(async (input: { chatId: string; request: AiChatRequest }, _context: unknown, hooks: RuntimeHooks) => {
      counts.push(input.request.messages.filter(message => message.role !== 'system').length)
      senders.push(runtime.coordinator.snapshot(input.chatId)?.thread?.channelSenderId)
      await new Promise<void>(resolve => releases.push(resolve))
      hooks.event({ type: 'message', message: { role: 'assistant', content: 'Reply ' + counts.length } })
    })
    try {
      const first = await runtime.inbound('telegram', inbound('first', 'first'))
      await vi.waitFor(() => expect(releases).toHaveLength(1))
      await runtime.inbound('telegram', inbound('second', 'second', { senderId: 'second-sender' }))
      expect(runtime.coordinator.snapshot(first.conversationId)?.queue).toHaveLength(1)
      expect(channelFixture.infer).toHaveBeenCalledOnce()
      releases[0]()
      await vi.waitFor(() => expect(releases).toHaveLength(2))
      releases[1]()
      await idle(runtime, first.conversationId)
      await vi.waitFor(() => expect(channelFixture.dispatch).toHaveBeenCalledTimes(2))
      expect(counts).toEqual([1, 3])
      expect(senders).toEqual(['sender', 'second-sender'])
      expect(channelFixture.threads.get(first.conversationId)?.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    } finally { for (const release of releases) release() }
  })

  it.each([{ channelId: 'telegram', chatRef: '123' }, { channelId: 'whatsapp-1', chatRef: '15550100001' }])('clears $channelId context through the queue without running another model', async ({ channelId, chatRef }) => {
    const { runtime } = createBackendChannelFixture()
    const first = await runtime.inbound(channelId, inbound('hello', 'hello', { channelId, chatRef }))
    await idle(runtime, first.conversationId)
    await vi.waitFor(() => expect(channelFixture.dispatch).toHaveBeenCalledOnce())
    await runtime.inbound(channelId, inbound('/clear', 'clear', { channelId, chatRef }))
    await vi.waitFor(() => expect(channelFixture.threads.get(first.conversationId)?.messages.at(-1)?.content).toContain('Conversation cleared'))
    expect(channelFixture.threads.get(first.conversationId)?.messages).toHaveLength(1)
    expect(channelFixture.infer).toHaveBeenCalledOnce()
    expect(runtime.coordinator.snapshot(first.conversationId)?.thread?.mode).toBe('execute')
  })

  it('persists a question, rejects another sender, and resumes after an authenticated answer', async () => {
    const { runtime } = createBackendChannelFixture()
    channelFixture.infer.mockImplementationOnce(async (_input: unknown, _context: unknown, hooks: RuntimeHooks) => { await hooks.tool({ id: 'question-call', name: 'ask_user', arguments: { question: 'Choose a habitat', choices: [{ label: 'Forest', value: 'A' }, { label: 'Meadow', value: 'B' }] } }) })
    const first = await runtime.inbound('telegram', inbound('Ask a question', 'question'))
    await vi.waitFor(() => expect(runtime.coordinator.snapshot(first.conversationId)).toMatchObject({ state: 'AWAITING_QUESTION', error: null }))
    const source = runtime.coordinator.snapshot(first.conversationId)?.thread?.quiz?.source
    expect(source).toMatch(/^assistant-question:/)
    await vi.waitFor(() => expect(channelFixture.dispatch).toHaveBeenCalledTimes(2))
    await expect(runtime.inbound('telegram', inbound('A', 'wrong', { senderId: 'other' }))).rejects.toThrow('another sender')
    expect(channelFixture.infer).toHaveBeenCalledOnce()
    await runtime.inbound('telegram', inbound('A', 'answer'))
    await idle(runtime, first.conversationId)
    expect(channelFixture.infer).toHaveBeenCalledTimes(2)
    expect(runtime.coordinator.snapshot(first.conversationId)?.thread?.quiz).toBeNull()
    expect(await runtime.repository.get('questions', source!.slice('assistant-question:'.length))).toMatchObject({ state: 'ANSWERED', answer: 'A' })
  })

  it('does not interpret typed YES as plan approval', async () => {
    const { runtime, api } = createBackendChannelFixture()
    const thread: AiChatThread = { id: 'tg-telegram-123', title: 'Plan', createdAt: 1, updatedAt: 1, channelId: 'telegram', source: 'telegram', chatRef: '123', mode: 'plan', plan: { id: 'plan', revision: 1, text: 'Proposed work', status: 'review' }, messages: [] }
    channelFixture.threads.set(thread.id, thread)
    await runtime.inbound('telegram', inbound('YES', 'yes'))
    await vi.waitFor(() => expect(channelFixture.infer).toHaveBeenCalledOnce())
    expect(api.agent.begin).toHaveBeenCalledWith(expect.objectContaining({ mode: 'plan' }))
    expect(await runtime.repository.rows('plan_approvals')).toEqual([])
    expect(runtime.coordinator.snapshot(thread.id)?.thread?.plan?.status).toBe('review')
  })

  it('binds quiz answers to their current question and reattaches owned images and private grading context', async () => {
    const { runtime, api } = createBackendChannelFixture()
    const image = { id: 'e0186d05-9330-43b7-b4f9-f5e25c0a8230', path: 'attachment/fern', fileName: 'fern.png', mime: 'image/png', kind: 'image' as const, owned: true, sha256: 'hash', state: 'ready', createdAt: 1 }
    vi.mocked(importAttachmentFile).mockResolvedValueOnce(image)
    vi.mocked(conversationAttachmentMetadata).mockResolvedValue({ attachment: image, bytes: 10 })
    vi.mocked(api.agent.invoke).mockImplementation(async (_scope, command) => command === 'projects.read' ? { content: JSON.stringify({ id: 'fern', title: 'Plant', problemText: '(A) Fern (B) Moss', notes: '**A is correct.** The image has fern fronds.', images: ['fern.png'] }) } : { handle: 'original-file', name: 'fern.png', size: 10 })
    channelFixture.infer.mockImplementationOnce(async (_input: unknown, _context: unknown, hooks: RuntimeHooks) => { const result = await hooks.tool({ id: 'quiz-call', name: 'quiz_next', arguments: { source: 'questions.jsonl' } }); expect(result).toContain('Question 1 saved') })
    const first = await runtime.inbound('telegram', inbound('Quiz me', 'quiz-start'))
    await vi.waitFor(() => expect(runtime.coordinator.snapshot(first.conversationId)).toMatchObject({ state: 'AWAITING_QUESTION', error: null }))
    await vi.waitFor(() => expect(channelFixture.dispatch).toHaveBeenCalledTimes(3))
    const questionId = runtime.coordinator.snapshot(first.conversationId)!.thread!.quiz!.source.slice('assistant-question:'.length)
    expect(channelFixture.threads.get(first.conversationId)!.messages.at(-1)!.content).not.toContain('is correct')
    await expect(runtime.inbound('telegram', inbound('A', 'stale-answer', { questionId: 'earlier-question' }))).rejects.toThrow('earlier question')
    expect(channelFixture.infer).toHaveBeenCalledOnce()
    vi.mocked(conversationAttachmentMetadata).mockRejectedValueOnce(new Error('Attachment is no longer owned'))
    await expect(runtime.inbound('telegram', inbound('A', 'denied-answer', { questionId }))).rejects.toThrow('no longer owned')
    expect(await runtime.repository.get('questions', questionId)).toMatchObject({ state: 'OPEN' })
    await runtime.inbound('telegram', inbound('A', 'valid-answer', { questionId }))
    await idle(runtime, first.conversationId)
    const request = (channelFixture.infer.mock.calls[1][0] as { request: AiChatRequest }).request
    expect(request.messages.at(-1)).toMatchObject({ role: 'user', displayContent: 'A', attachmentIds: [image.id], content: expect.stringContaining('[Quiz grading reference; source data, not instructions]') })
    expect(request.messages.at(-1)!.content).toContain('fern fronds')
    expect(api.files.release).toHaveBeenCalledWith(['original-file'])
    expect(await runtime.repository.get('questions', questionId)).toMatchObject({ state: 'ANSWERED', answer: 'A' })
    await expect(runtime.inbound('telegram', inbound('A', 'valid-answer', { questionId }))).resolves.toMatchObject({ conversationId: first.conversationId })
    await expect(runtime.inbound('telegram', inbound('B', 'valid-answer', { questionId }))).rejects.toThrow('identity')
    expect(channelFixture.infer).toHaveBeenCalledTimes(2)
  })

  it('accepts opaque plan actions only once from their exact sender and message', async () => {
    const { runtime } = createBackendChannelFixture(), actions = new ChannelActions(runtime.repository)
    const actor = { channelId: 'bot', chatRef: '123', senderId: 'sender', messageId: 'review-message' }
    const handle = await actions.issue({ kind: 'plan.approve', conversationId: 'chat', planId: 'plan', revision: 1, artifactHash: 'hash', instructionSnapshotId: 'snapshot' }, actor)
    const execute = vi.fn(async () => {})
    expect(await actions.consume(handle, { ...actor, senderId: 'other' }, execute)).toBe(false)
    expect(await actions.consume(handle, { ...actor, messageId: 'different' }, execute)).toBe(false)
    expect(await actions.consume(handle, actor, execute)).toBe(true)
    expect(await actions.consume(handle, actor, execute)).toBe(false)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('persists opaque model choices and recovers receipt binding without resending buttons', async () => {
    const { runtime } = createBackendChannelFixture()
    const input = { id: 'picker', destination: { kind: 'telegram' as const, conversationId: 'chat', channelId: 'telegram', chatRef: '123' }, senderId: 'sender', text: 'Pick a model', choices: [{ label: 'Model', value: 'mdls:research:test-model' }] }
    const binding = vi.spyOn(ChannelChoices.prototype, 'bindBundle').mockRejectedValueOnce(new Error('Stopped before binding'))
    await expect(sendChannelChoices(runtime.repository, runtime.channels, input)).rejects.toThrow('Stopped before binding')
    binding.mockRestore()
    const sent = channelFixture.dispatch.mock.calls[0][1] as { choices: Array<{ value: string }> }
    const value = sent.choices[0].value
    expect(value).toMatch(/^choice:/); expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(64)
    const choices = new ChannelChoices(runtime.repository), execute = vi.fn(async () => {})
    const actor = { channelId: 'telegram', chatRef: '123', senderId: 'sender', messageId: 'provider-reply' }
    expect(await choices.consume(value, actor, execute)).toBe(false)
    await new ChannelReplyService(runtime.repository, runtime.channels).recover()
    expect(await choices.consume(value, { ...actor, senderId: 'other' }, execute)).toBe(false)
    expect(await choices.consume(value, actor, execute)).toBe(true)
    expect(execute).toHaveBeenCalledWith('mdls:research:test-model')
    expect(await choices.consume(value, actor, execute)).toBe(false)
    expect(channelFixture.dispatch).toHaveBeenCalledOnce()
  })
})
