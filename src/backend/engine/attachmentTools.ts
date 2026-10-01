import { z } from 'zod'
import { importAttachmentFile, referenceAttachments } from '../attachments'
import { executionFile, type executionContext } from '../projects'
import type { ToolRegistry } from '../tools/registry'

export function registerAttachmentImport(registry: ToolRegistry, options: { conversationId: string; scopeId: string; planning: boolean; access: Awaited<ReturnType<typeof executionContext>> }): void {
  registry.register({
    name: 'attachment_import', description: 'Copy an existing generated file from the authorized working directory into durable storage for this conversation. Preserves its original filename and bytes; returns an attachment ID, MIME type and kind. Use that ID with channel_send for remote delivery. Import alone sends nothing.',
    group: 'general', parameters: z.object({ path: z.string().trim().min(1).max(4096), rootId: z.string().min(1).max(256).optional() }).strict(),
    output: z.object({ id: z.string().uuid(), fileName: z.string(), mime: z.string(), kind: z.enum(['image', 'pdf', 'audio', 'file']), path: z.string() }).strict(),
    effect: 'non-idempotent', timeoutMs: 120000, requiredCapabilities: [], guardTargets: () => [],
    execute: async (input, context) => {
      if (options.planning || context.planning) throw new Error('Plan mode forbids attachment imports. Review and approve the plan first.')
      if (context.conversationId !== options.conversationId) throw new Error('Attachment import belongs to another conversation')
      context.operation.cancellation.throwIfAborted()
      const api = context.operation.api, source = executionFile(options.access, input.rootId ?? options.access.root.id, input.path)
      await api.agent.invoke(options.scopeId, 'authorize.external', { target: { kind: 'tool', id: 'channel.attachment_import', sideEffect: 'write' }, arguments: { destination: { kind: 'chat', conversationId: options.conversationId }, content: { type: 'attachment_import', ...source } } })
      context.operation.cancellation.throwIfAborted()
      const result = await api.agent.invoke(options.scopeId, 'projects.openFile', { ...source })
      const { handle } = z.object({ handle: z.string().min(1) }).passthrough().parse(result)
      try {
        const file = z.object({ handle: z.string().min(1), name: z.string().min(1).max(4096), size: z.number().int().nonnegative() }).passthrough().parse(result)
        context.operation.cancellation.throwIfAborted()
        const attachment = await importAttachmentFile({ fileHandle: file.handle, fileName: file.name, kind: 'file' }, api)
        if (!attachment.id || !attachment.mime) throw new Error('Imported file has no durable identity or MIME type')
        await referenceAttachments(options.conversationId, [{ role: 'assistant', content: '', attachmentIds: [attachment.id] }], api)
        return { id: attachment.id, fileName: attachment.fileName, mime: attachment.mime, kind: attachment.kind, path: attachment.path }
      } finally { await api.files.release([handle]) }
    }
  })
}
