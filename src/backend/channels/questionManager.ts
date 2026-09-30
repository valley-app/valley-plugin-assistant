import { z } from 'zod'
import type { DatasetTransactionOperation } from '@valley/plugin-sdk/datasets'
import { AssistantRepository, record } from '../persistence/repositories'
import { runExclusive } from '../fileQueue'

const inputSchema = z.object({ conversationId: z.string().min(1), connectionId: z.string().min(1), recipientId: z.string().min(1), text: z.string().min(1).max(10000), choices: z.array(z.object({ value: z.string().min(1).max(64), label: z.string().min(1).max(256) }).strict()).max(20).default([]), attachmentIds: z.array(z.string().uuid()).max(8).optional(), quiz: z.object({ source: z.string().min(1).max(4096), problemId: z.string().min(1).max(1024), servedIds: z.array(z.string().max(1024)).max(10000), context: z.string().max(24000) }).strict().optional() }).strict()
export interface Question extends z.infer<typeof inputSchema> {
  id: string
  expiresAt: number
  state: 'OPEN' | 'ANSWERED' | 'EXPIRED'
  answer?: string
}

export class QuestionManager {
  constructor(private repository: AssistantRepository) {}
  async create(input: z.input<typeof inputSchema>, effects: DatasetTransactionOperation[] = []): Promise<Question> {
    const question: Question = { ...inputSchema.parse(input), id: crypto.randomUUID(), expiresAt: Date.now() + 24 * 60 * 60 * 1000, state: 'OPEN' }
    await this.repository.data.transaction([{ dataset: 'questions', operation: 'insert', values: record(question.id, question.conversationId, question.state, question) }, ...effects])
    return question
  }

  async answer(input: { id: string; connectionId: string; senderId: string; conversationId: string; answer: string }, continuation: (question: Question) => DatasetTransactionOperation[]): Promise<boolean> {
    return runExclusive(`question:${input.id}`, async () => {
      const question = await this.repository.get<Question>('questions', input.id)
      if (!question || question.state !== 'OPEN' || question.connectionId !== input.connectionId || question.recipientId !== input.senderId || question.conversationId !== input.conversationId) return false
      if (question.expiresAt <= Date.now()) { await this.expire(question, continuation); return false }
      if (!input.answer.trim() || input.answer.length > 32000 || question.choices.length && !question.choices.some(choice => choice.value === input.answer)) return false
      question.answer = input.answer; question.state = 'ANSWERED'
      await this.repository.data.transaction([{ dataset: 'questions', operation: 'update', key: { id: question.id }, values: record(question.id, question.conversationId, question.state, question) }, ...continuation(question)])
      return true
    })
  }

  private async expire(question: Question, continuation: (question: Question) => DatasetTransactionOperation[]) {
    question.state = 'EXPIRED'
    await this.repository.data.transaction([{ dataset: 'questions', operation: 'update', key: { id: question.id }, values: record(question.id, question.conversationId, question.state, question) }, ...continuation(question)])
  }

  async expireDue(continuation: (question: Question) => DatasetTransactionOperation[]): Promise<void> {
    for (const question of await this.repository.rows<Question>('questions', { state: 'OPEN' })) if (question.expiresAt <= Date.now()) await runExclusive(`question:${question.id}`, async () => {
      const current = await this.repository.get<Question>('questions', question.id)
      if (current?.state === 'OPEN' && current.expiresAt <= Date.now()) await this.expire(current, continuation)
    })
  }
}
