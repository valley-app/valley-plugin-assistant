import { z } from 'zod'
import path from 'path-browserify'
import type { AiChatThread, InboundAttachment } from '../../types'
import { answerChoices, parseProblems, pickProblem } from '../../quiz'
import { importAttachmentFile, referenceAttachments } from '../attachments'
import { executionFile, type executionContext } from '../projects'
import { QuestionManager } from '../channels/questionManager'
import { record, type AssistantRepository } from '../persistence/repositories'
import type { ToolRegistry } from '../tools/registry'
import type { RunControls } from './coordinator'

interface QuizPorts {
  thread: AiChatThread
  controls: RunControls
  scopeId: string
  access: Awaited<ReturnType<typeof executionContext>>
  stop(): void
}

export function registerQuizTools(registry: ToolRegistry, repository: AssistantRepository, ports: QuizPorts): void {
  registry.register({
    name: 'quiz_next', description: 'Present the next unserved practice question from a JSONL file in the authorized working directory. Imports its question images, saves answer choices durably, and waits for the user. The worked solution remains private until they answer.',
    group: 'chat', parameters: z.object({ source: z.string().trim().min(1).max(4096), reset: z.boolean().default(false), multipleChoiceOnly: z.boolean().default(false), subject: z.string().max(256).optional() }).strict(), output: z.string(), effect: 'non-idempotent', timeoutMs: 120000, requiredCapabilities: [], guardTargets: () => [],
    execute: async (args, context) => {
      if (context.planning || ports.thread.mode === 'plan') throw new Error('Plan mode cannot start a quiz. Approve the plan before implementation.')
      if (ports.thread.quiz?.source.startsWith('assistant-question:')) throw new Error('Answer the current question before starting another one')
      const api = context.operation.api, source = executionFile(ports.access, ports.access.root.id, args.source)
      const result = z.object({ content: z.string().max(4 * 1024 * 1024) }).passthrough().parse(await api.agent.invoke(ports.scopeId, 'projects.read', { ...source }))
      const problems = parseProblems(result.content).filter(problem => problem.id && problem.id.length <= 1024)
      if (!problems.length) return `No quiz problems found in ${args.source}.`
      const sourceKey = `${source.rootId}:${source.path}`
      const previous = await repository.get<{ source: string; servedIds: string[] }>('quiz_sessions', ports.thread.id)
      const served = new Set(args.reset || previous?.source !== sourceKey ? [] : previous.servedIds)
      const problem = pickProblem(problems, served, { multipleChoiceOnly: args.multipleChoiceOnly, subject: args.subject })
      if (!problem) return `Quiz complete: all matching questions in ${args.source} have been served. Set reset=true to start again.`
      if (served.size >= 10000) throw new Error('Quiz history reached its limit. Reset this source before continuing.')
      const questionText = [problem.title, problem.problemText || 'Read the question in the attached image.'].filter(Boolean).join('\n\n')
      if (questionText.length > 10000 || problem.images.length > 8) throw new Error('This question exceeds the supported text or image limit; the source was preserved.')
      const attachments: InboundAttachment[] = []
      for (const image of problem.images) {
        const file = executionFile(ports.access, ports.access.root.id, image)
        const opened = z.object({ handle: z.string(), name: z.string(), size: z.number().nonnegative() }).passthrough().parse(await api.agent.invoke(ports.scopeId, 'projects.openFile', { ...file }))
        try {
          const attachment = await importAttachmentFile({ fileHandle: opened.handle, fileName: opened.name || path.basename(image), kind: 'image' })
          if (!attachment.id || attachment.kind !== 'image') throw new Error('Question image is not a supported image; original bytes were preserved.')
          attachments.push(attachment)
        } finally { await api.files.release([opened.handle]) }
      }
      await referenceAttachments(ports.thread.id, [{ role: 'assistant', content: questionText, attachmentIds: attachments.flatMap(attachment => attachment.id ? [attachment.id] : []) }])
      served.add(problem.id)
      const choices = answerChoices(problem)
      const privateContext = [`Quiz source: ${args.source}; question ID: ${problem.id}.`, `Question: ${problem.problemText}`, `Correct answer: ${problem.answerLetter ?? 'Judge using the worked solution.'}`, `Worked solution:\n${problem.explanation}`, problem.solutionImages.length ? `Solution image references: ${problem.solutionImages.join(', ')}` : ''].filter(Boolean).join('\n\n').slice(0, 24000)
      const question = await new QuestionManager(repository).create({ conversationId: ports.thread.id, connectionId: ports.thread.channelId ?? 'local', recipientId: ports.thread.channelSenderId ?? 'local-user', text: questionText, choices, attachmentIds: attachments.map(attachment => attachment.id!), quiz: { source: sourceKey, problemId: problem.id, servedIds: [...served], context: privateContext } }, [{ dataset: 'quiz_sessions', operation: 'upsert', values: record(ports.thread.id, ports.thread.id, 'ACTIVE', { source: sourceKey, servedIds: [...served] }) }])
      await ports.controls.update(thread => { thread.quiz = { source: `assistant-question:${question.id}`, choices, imagePath: attachments[0]?.path } })
      await ports.controls.message({ id: `quiz:${question.id}`, role: 'assistant', content: questionText, attachmentIds: question.attachmentIds, attachmentFiles: attachments.map(attachment => ({ fileName: attachment.fileName, path: attachment.path, kind: attachment.kind, mime: attachment.mime })), ts: Date.now() })
      ports.stop()
      return `Question ${served.size} saved. Wait for the authenticated answer before grading it. Do not reveal this private reference before the user answers.\n\n${privateContext}`
    }
  })
}
