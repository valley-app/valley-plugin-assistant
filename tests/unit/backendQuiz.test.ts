import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import type { ToolExecutionContext } from '../../src/contracts/tools'
import type { SessionSnapshot } from '../../src/contracts/execution'
import type { AiChatThread } from '../../src/types'
import { registerQuizTools } from '../../src/backend/engine/quiz'
import { ToolRegistry } from '../../src/backend/tools/registry'
import { AssistantRepository, record } from '../../src/backend/persistence/repositories'
import { ChannelReplyService } from '../../src/backend/channels/replies'
import { ChannelChoices } from '../../src/backend/channels/actions'
import { DeliveryQueue } from '../../src/backend/channels/deliveryQueue'
import type { ChannelBus } from '../../src/backend/channels/bus'
import type { Question } from '../../src/backend/channels/questionManager'
import { initBackend } from '../../src/backend/runtime'
import { datasetFixture } from '../backendDatasetFixture'

const hooks = vi.hoisted(() => ({ importFile: vi.fn(), reference: vi.fn() }))
vi.mock('../../src/backend/attachments', () => ({ importAttachmentFile: hooks.importFile, referenceAttachments: hooks.reference }))
vi.mock('../../src/backend/projects', () => ({ executionFile: (access: { root: { id: string } }, rootId: string, file: string) => { if (rootId !== access.root.id || file.startsWith('../')) throw new Error('Outside authorized root'); return { rootId, path: file } } }))
const imageId = '8406fca9-6919-4b82-a110-f4092f6b75e0'
const source = [{ id: 'moss', title: 'Wald', problemText: 'Was wächst hier? (A) Moos (B) Sand', notes: '**A ist richtig.** Feuchter Boden.', images: ['images/moss.png'] }, { id: 'fern', title: 'Farn', problemText: 'Welche Pflanze?', notes: 'Farn.', images: [] }]
beforeEach(() => { hooks.importFile.mockReset().mockResolvedValue({ id: imageId, path: 'attachment/moss', fileName: 'moss.png', mime: 'image/png', kind: 'image' }); hooks.reference.mockReset().mockResolvedValue(undefined) })

function fixture(kind: 'telegram' | 'whatsapp' = 'telegram') {
  const repository = new AssistantRepository(datasetFixture()), registry = new ToolRegistry()
  const thread: AiChatThread = { id: 'quiz-chat', title: 'Botany', createdAt: 1, updatedAt: 1, source: kind, channelId: 'connection', channelSenderId: 'student', chatRef: '123', messages: [] }
  const invoke = vi.fn(async (_scope: string, command: string) => command === 'projects.read' ? { content: source.map(problem => JSON.stringify(problem)).join('\n') } : { handle: 'image-handle', name: 'moss.png', size: 10 })
  const release = vi.fn(async () => {}), stop = vi.fn()
  const api = { data: repository.data, agent: { invoke }, files: { release } } as unknown as PluginBackendApi
  initBackend(api)
  const ports = { thread, controls: { update: async (change: (value: AiChatThread) => void) => change(thread), message: async (message: AiChatThread['messages'][number]) => { thread.messages.push(message) } }, scopeId: 'scope', access: { root: { id: 'root', path: '/vault' } }, stop } as unknown as Parameters<typeof registerQuizTools>[2]
  registerQuizTools(registry, repository, ports)
  const context = { planning: false, conversationId: thread.id, operation: { api } } as unknown as ToolExecutionContext
  const run = async (input: Record<string, unknown> = {}) => { const tool = registry.get('quiz_next')!; return tool.execute(tool.parameters.parse({ source: 'questions.jsonl', multipleChoiceOnly: true, ...input }), context) }
  const queue = new DeliveryQueue(repository), dispatch = vi.fn(async (input: Parameters<ChannelBus['send']>[0]) => [`receipt:${input.id}`])
  const bus = { send: (input: Parameters<ChannelBus['send']>[0]) => queue.send(input, () => dispatch(input)) }
  const snapshot = (): SessionSnapshot => ({ conversationId: thread.id, revision: 1, state: 'AWAITING_QUESTION', runId: null, streamingText: '', queue: [], paused: false, error: null, context: null, thread })
  return { repository, registry, ports, thread, invoke, release, stop, run, context, dispatch, replies: new ChannelReplyService(repository, bus), snapshot }
}

describe('durable backend quizzes', () => {
  it('imports guarded original images and persists the private answer separately from the question', async () => {
    const value = fixture()
    const result = await value.run()
    expect(value.invoke).toHaveBeenCalledWith('scope', 'projects.read', { rootId: 'root', path: 'questions.jsonl' })
    expect(value.invoke).toHaveBeenCalledWith('scope', 'projects.openFile', { rootId: 'root', path: 'images/moss.png' })
    expect(hooks.importFile).toHaveBeenCalledWith({ fileHandle: 'image-handle', fileName: 'moss.png', kind: 'image' })
    expect(value.release).toHaveBeenCalledWith(['image-handle'])
    expect(value.thread.messages[0]).toMatchObject({ attachmentIds: [imageId], content: expect.stringContaining('wächst') })
    expect(value.thread.messages[0].content).not.toContain('ist richtig')
    const question = (await value.repository.rows<Question>('questions'))[0]
    expect(question).toMatchObject({ state: 'OPEN', attachmentIds: [imageId], quiz: { problemId: 'moss', context: expect.stringContaining('A ist richtig') } })
    expect(result).toContain('Wait for the authenticated answer')
    expect(value.stop).toHaveBeenCalledOnce()
  })

  it('preserves served IDs across tool registration and restarts until explicitly reset', async () => {
    const value = fixture()
    await value.run(); value.thread.quiz = null
    const restored = new ToolRegistry(); registerQuizTools(restored, value.repository, value.ports)
    const tool = restored.get('quiz_next')!
    expect(await tool.execute(tool.parameters.parse({ source: 'questions.jsonl', multipleChoiceOnly: true }), value.context)).toContain('Quiz complete')
    expect(await value.run({ reset: true })).toContain('Question 1 saved')
    expect(await value.repository.get('quiz_sessions', value.thread.id)).toMatchObject({ servedIds: ['moss'] })
  })

  it('does not start quizzes in Plan mode or after a rejected scoped file read', async () => {
    const value = fixture()
    value.context.planning = true
    await expect(value.run()).rejects.toThrow('Plan mode')
    expect(value.invoke).not.toHaveBeenCalled()
    value.context.planning = false; value.invoke.mockRejectedValueOnce(new Error('Guard denied'))
    await expect(value.run()).rejects.toThrow('Guard denied')
    expect(await value.repository.rows('questions')).toEqual([])
    expect(hooks.importFile).not.toHaveBeenCalled()
  })

  it('projects images and opaque answer buttons once, then rejects wrong senders and closed questions', async () => {
    const value = fixture()
    await value.run(); await value.replies.deliver(value.snapshot()); await value.replies.deliver(value.snapshot())
    expect(value.dispatch).toHaveBeenCalledTimes(3)
    expect(value.dispatch.mock.calls.map(([input]) => input.content.type)).toEqual(['attachment', 'text', 'buttons'])
    const buttons = value.dispatch.mock.calls[2][0]
    if (buttons.content.type !== 'buttons') throw new Error('Missing quiz buttons')
    const actor = { channelId: 'connection', chatRef: '123', senderId: 'student', messageId: `receipt:${buttons.id}` }, handles = new ChannelChoices(value.repository), answer = vi.fn(async () => {})
    const question = (await value.repository.rows<Question>('questions'))[0]
    expect(await handles.consume(buttons.content.choices[0].value, { ...actor, senderId: 'intruder' }, answer)).toBe(false)
    expect(await handles.consume(buttons.content.choices[0].value, actor, answer)).toBe(true)
    expect(answer).toHaveBeenCalledWith('A', question.id)
    await value.repository.data.transaction([{ dataset: 'questions', operation: 'upsert', values: record(question.id, question.conversationId, 'ANSWERED', { ...question, state: 'ANSWERED' }) }])
    expect(await handles.consume(buttons.content.choices[1].value, actor, answer)).toBe(false)
  })

  it('uses a WhatsApp list for four quiz choices and preserves non-Latin labels', async () => {
    const value = fixture('whatsapp')
    value.invoke.mockResolvedValueOnce({ content: JSON.stringify({ ...source[0], problemText: 'Wähle (A) Äste (B) Blätter (C) Blüten (D) Wurzeln' }) })
    await value.run(); await value.replies.deliver(value.snapshot())
    const choice = value.dispatch.mock.calls[2][0].content
    expect(choice.type).toBe('list')
    if (choice.type === 'list') expect(choice.sections[0].rows.map(row => row.title)).toEqual(['A', 'B', 'C', 'D'])
    expect(value.thread.messages[0].content).toContain('Blüten')
  })

  it('prevents stale choice handles from reviving a deleted conversation', async () => {
    const value = fixture()
    await value.run(); await value.replies.deliver(value.snapshot())
    const buttons = value.dispatch.mock.calls[2][0]
    if (buttons.content.type !== 'buttons') throw new Error('Missing quiz buttons')
    await value.repository.data.transaction([{ dataset: 'conversation_deletions', operation: 'upsert', values: record(value.thread.id, value.thread.id, 'DELETED', { deletedAt: Date.now() }) }])
    expect(await new ChannelChoices(value.repository).consume(buttons.content.choices[0].value, { channelId: 'connection', chatRef: '123', senderId: 'student', messageId: `receipt:${buttons.id}` }, vi.fn())).toBe(false)
  })
})
