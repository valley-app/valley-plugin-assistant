import * as fs from './filesystem'
import { effectiveSettings, readSettingsDocument, saveSettings, settingsSchema } from './configuration/settings'
import { AssistantRuntime } from './engine/service'
import { configurationHandlers } from './configuration'
import { configurationDomainHandlers, configurationDomainSchemas } from './configuration/domainCommands'
import { readConfig } from './store'
import { rebuildChatSearch, listChats, readChat, renameChat, deleteChat, clearChat, setChatPinned, saveChat } from './threads'
import { readMemory } from './memory'
import { steerRuntime, runNativeRuntime, respondToRuntime } from './runtimes'
import { z } from 'zod'
import { executeProjectCommand, stopProjectProcesses } from './projectExecution'
import { projectRequest, resumeProjectCleanup } from './projects'
import { activityRequest } from './activity'
import { importAttachmentFile, resumeAttachmentCleanup, discardAttachment, importTransferredAttachments } from './attachments'
import type { PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import { computeEmbeddings, computeEmbeddingsV2 } from './embeddings'
import { runSkill, skillRequestSchema, toolboxRequest } from './skills'
import { aiDriver, chatThread } from './aiRpc'
import { channelsDriver } from './channelsRpc'
import { initBackend, backendApi, VAULT_ROOT, t, closeBackend, drainBackgroundOperations } from './runtime'
import { releaseFileAccess } from './filesystem'
import { channelManager } from './channels/manager'
import { cancelAllHarnessRuns } from './harness/runner'
import { relayAiStream, cancelAllRuns } from './engine'
export function register(api: PluginBackendApi): () => Promise<void> {
  initBackend(api)
  const runtime = new AssistantRuntime(api)
  channelManager.bindRuntime({ repository: runtime.repository, onInbound: (id, message) => runtime.inbound(id, { ...message, channelId: id, ts: message.receivedAt ?? Date.now() }).then(() => {}), onLifecycle: async (id, event) => { if (event.type === 'receipt' && event.state) await runtime.channels.deliveries.providerReceipt(id, event.providerMessageId, event.state, event.error) }, onAction: async (_id, action, actor) => { if (action.kind === 'plan.approve') await runtime.approve(action.conversationId, action, `${actor.channelId}:${actor.chatRef}:${actor.senderId}`); else await runtime.coordinator.change(action.conversationId, async thread => { if (thread.plan?.id !== action.planId || thread.plan.revision !== action.revision) throw new Error('Plan changed'); thread.plan.status = 'changes'; thread.mode = 'plan'; return {} }) } })
  const offAi = api.ai.onStream(event => relayAiStream(api, event))
  let active = true
  let disposal: Promise<void> | undefined
  const pending = new Set<Promise<unknown>>()
  const ready = importTransferredAttachments().then(() => Promise.all([resumeAttachmentCleanup(), resumeProjectCleanup()])).then(() => rebuildChatSearch(VAULT_ROOT)).then(() => readConfig(VAULT_ROOT)).then(() => runtime.restore())
  void ready.catch(error => api.rpc.emit('backendError', String(error)))
  const accepted = <T>(operation: () => Promise<T>): Promise<T> => {
    if (!active) return Promise.reject(new Error('Assistant backend is closing'))
    if (pending.size >= 64) return Promise.reject(new Error('Too many Assistant requests are pending'))
    const task = ready.then(() => { if (backendApi() !== api) throw new Error('Assistant backend changed before request'); return operation() })
    pending.add(task)
    void task.then(() => pending.delete(task), () => pending.delete(task))
    return task
  }
  const startup = ready.then(() => { if (active) return channelManager.ensureStarted(VAULT_ROOT).then(() => channelManager.recoverInbound()) }).catch((error) => { if (active) api.rpc.emit('backendError', String(error)) })
  const sessionInput = z.object({ conversationId: z.string().min(1).max(256) })
  const commandHandlers: Record<string, (input: unknown, owner: PluginBackendOperationContext['api'], context?: PluginBackendOperationContext) => Promise<unknown>> = {
    'command.settings.read': (_input, owner) => readSettingsDocument(VAULT_ROOT, owner),
    'command.settings.patch': async (input, owner) => {
      const value = z.object({ expectedRevision: z.number().int().nonnegative(), patch: settingsSchema.partial().strict() }).strict().parse(input)
      try { await saveSettings(VAULT_ROOT, value.patch, value.expectedRevision, owner); return { ok: true, data: await readSettingsDocument(VAULT_ROOT, owner) } }
      catch (error) {
        if ((error as { code?: string }).code === 'REVISION_CONFLICT') return { ok: false, code: 'REVISION_CONFLICT', outcome: 'not-applied', error: 'Assistant settings changed; reload before patching', currentRevision: (error as { currentRevision?: number }).currentRevision }
        throw error
      }
    },
    'command.session.snapshot': async input => runtime.coordinator.snapshot(sessionInput.strict().parse(input).conversationId) ?? null,
    'command.session.submit': async (input, owner, context) => { const value = z.object({ id: z.string().min(1).max(512), conversationId: z.string().min(1).max(256), text: z.string().min(1).max(500000) }).strict().parse(input); await runtime.submit(value, owner); return runtime.coordinator.waitForTurn(value.conversationId, value.id, context?.cancellation) },
    'command.session.stop': async (input, owner) => { await runtime.coordinator.stop(sessionInput.strict().parse(input).conversationId, owner); return null },
    'command.session.resume': async (input, owner, context) => { const id = sessionInput.strict().parse(input).conversationId; await runtime.coordinator.resume(id, owner); await runtime.coordinator.waitForTurn(id, undefined, context?.cancellation); return null },
    'command.session.queue': async (input, owner, context) => { const value = sessionInput.extend({ turnId: z.string().min(1).max(256), patch: z.object({ text: z.string().max(500000).optional(), editing: z.boolean().optional(), index: z.number().int().nonnegative().optional(), remove: z.boolean().optional() }).strict() }).strict().parse(input); await runtime.coordinator.edit(value.conversationId, value.turnId, value.patch, owner); if (!value.patch.remove && !runtime.coordinator.snapshot(value.conversationId)?.queue.find(turn => turn.id === value.turnId)?.editing) await runtime.coordinator.waitForTurn(value.conversationId, value.turnId, context?.cancellation); return null },
    'command.session.steer': async (input, owner, context) => { const value = sessionInput.extend({ turnId: z.string().min(1).max(256) }).strict().parse(input); await runtime.coordinator.steer(value.conversationId, value.turnId, owner); await runtime.coordinator.waitForTurn(value.conversationId, value.turnId, context?.cancellation); return null },
    'command.session.plan': async (input, owner) => { const value = sessionInput.strict().parse(input); await runtime.coordinator.change(value.conversationId, async thread => { thread.mode = 'plan'; if (thread.plan) thread.plan.status = 'changes'; return {} }, owner); return null }
  }
  for (const name of ['listChats', 'readChat', 'renameChat', 'deleteChat', 'clearChat', 'setChatPinned', 'readMemory'] as const) commandHandlers[`command.${name}`] = async (input, owner) => {
    const method = aiDriver[name], payload = method.schema.parse(input)
    if (name === 'deleteChat' || name === 'clearChat') await runtime.coordinator.remove((payload as { id: string }).id, owner)
    const value = payload as { id: string; title: string; pinned: boolean }
    if (name === 'listChats') return { chats: await listChats(VAULT_ROOT, false, owner) }
    if (name === 'readChat') return { thread: await readChat(VAULT_ROOT, value.id, owner) }
    if (name === 'renameChat') await renameChat(VAULT_ROOT, value.id, value.title, owner)
    if (name === 'deleteChat') await deleteChat(VAULT_ROOT, value.id, owner)
    if (name === 'clearChat') await clearChat(VAULT_ROOT, value.id, owner)
    if (name === 'setChatPinned') await setChatPinned(VAULT_ROOT, value.id, value.pinned, owner)
    if (name === 'readMemory') return { memory: await readMemory(VAULT_ROOT, (payload as { chatId: string }).chatId, owner) }
    return null
  }
  const offSessions = [
    ...Object.keys(configurationDomainSchemas).map(method => api.rpc.handleOperation(`command.${method}`, (input, context) => accepted(async () => {
      context.cancellation.throwIfAborted()
      return configurationDomainHandlers(VAULT_ROOT, context.api)[method as keyof typeof configurationDomainSchemas](input)
    }))),
    ...['configuration.status', 'configuration.note', 'configuration.note.set', 'configuration.link', 'configuration.speech', 'configuration.speech.set', 'configuration.conversation', 'configuration.conversation.set', 'configuration.project', 'configuration.project.set'].map(method => api.rpc.handleOperation(`command.${method}`, (input, context) => accepted(async () => {
      context.cancellation.throwIfAborted()
      return configurationHandlers(VAULT_ROOT, context.api)[method](input)
    }))),
    ...Object.entries(commandHandlers).map(([method, handler]) => api.rpc.handleOperation(method, (input, context) => accepted(async () => { context.cancellation.throwIfAborted(); return handler(input, context.api, context) }))),
    ...Object.entries(configurationHandlers(VAULT_ROOT)).map(([method, handler]) => api.rpc.handle(method, input => accepted(() => handler(input)))),
    api.rpc.handle('session.channelSend', input => accepted(async () => runtime.sendAsChannel(sessionInput.extend({ id: z.string().uuid(), text: z.string().trim().min(1).max(500000) }).strict().parse(input), api))),
    api.rpc.handle('session.snapshot', input => accepted(async () => runtime.coordinator.snapshot(sessionInput.parse(input).conversationId))),
    api.rpc.handle('session.submit', input => accepted(async () => { const value = z.object({ id: z.string().min(1).max(512), conversationId: z.string().min(1).max(256), text: z.string().max(500000), thread: chatThread.optional(), origin: z.literal('voice').optional(), attachments: z.array(z.object({ id: z.string().uuid(), path: z.string().min(1).max(4096), fileName: z.string().min(1).max(256), kind: z.enum(['image', 'pdf', 'audio', 'file']), mime: z.string().max(128).optional() }).strict()).max(32).optional() }).strict().parse(input); return runtime.submit(value, api) })),
    api.rpc.handle('session.interruptVoice', input => accepted(async () => { const id = sessionInput.parse(input).conversationId; if (['INFERRING', 'PREPARING'].includes(runtime.coordinator.snapshot(id)?.state ?? '')) await runtime.coordinator.stop(id, api) })),
    api.rpc.handle('session.stop', input => accepted(() => runtime.coordinator.stop(sessionInput.parse(input).conversationId, api))),
    api.rpc.handle('session.resume', input => accepted(() => runtime.coordinator.resume(sessionInput.parse(input).conversationId, api))),
    api.rpc.handle('session.queue', input => accepted(async () => { const value = sessionInput.extend({ turnId: z.string(), patch: z.object({ text: z.string().optional(), editing: z.boolean().optional(), index: z.number().int().nonnegative().optional(), remove: z.boolean().optional() }) }).strict().parse(input); await runtime.coordinator.edit(value.conversationId, value.turnId, value.patch, api) })),
    api.rpc.handle('session.steer', input => accepted(async () => { const value = sessionInput.extend({ turnId: z.string() }).strict().parse(input); await runtime.coordinator.steer(value.conversationId, value.turnId, api) })),
    api.rpc.handle('session.mode', input => accepted(async () => { const value = sessionInput.extend({ mode: z.literal('plan') }).strict().parse(input); await runtime.coordinator.change(value.conversationId, async thread => { thread.mode = 'plan'; if (thread.plan) thread.plan.status = 'changes'; return {} }, api) })),
    api.rpc.handle('plan.approve', input => accepted(async () => { const value = sessionInput.extend({ planId: z.string().uuid(), revision: z.number().int().positive(), artifactHash: z.string().length(64), instructionSnapshotId: z.string().length(64) }).strict().parse(input); await runtime.approve(value.conversationId, value, 'local-user', api) }))
  ]
  const uploads = new Map<string, { metadata: { fileName: string; mime?: string; kind: 'image' | 'pdf' | 'audio' | 'file'; folder?: string }; bytes: number; spool: string; createdAt: number }>()
  const uploadSchema = z.object({ fileName: z.string().min(1).max(256), mime: z.string().max(128).optional(), kind: z.enum(['image', 'pdf', 'audio', 'file']), folder: z.string().max(4096).optional() }).strict()
  const offAttachments = [
    api.rpc.handle('attachments.discard', input => accepted(async () => {
      const { id } = z.object({ id: z.string().uuid() }).strict().parse(input); await discardAttachment(id, api) })),
    api.rpc.handle('attachments.begin', input => accepted(async () => {
      const metadata = uploadSchema.parse(input)
      for (const [id, upload] of uploads) if (Date.now() - upload.createdAt > 600000) uploads.delete(id)
      if (uploads.size >= 4) throw new Error('Too many attachment uploads')
      const id = crypto.randomUUID()
      const spool = `${VAULT_ROOT}/.valley/plugins/data/assistant/media/inbound/upload-${id}.part`
      await fs.mkdir(spool.slice(0, spool.lastIndexOf('/')), { recursive: true }, api)
      uploads.set(id, { metadata, bytes: 0, spool, createdAt: Date.now() })
      return id
    })),
    api.rpc.handle('attachments.chunk', input => accepted(async () => {
      const { id, offset, base64 } = z.object({ id: z.string().uuid(), offset: z.number().int().nonnegative(), base64: z.string().max(1400000) }).strict().parse(input)
      const upload = uploads.get(id)
      if (!upload || upload.bytes !== offset) throw new Error('Attachment upload is unavailable or out of order')
      const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
      if (upload.bytes + bytes.length > (await effectiveSettings(VAULT_ROOT, api)).importMaxBytes) throw new Error('Attachment exceeds the configured import limit')
      await api.storage.writeBytes(await fs.storageLocation(upload.spool, 'write', api), base64, offset > 0)
      upload.bytes += bytes.length
    })),
    api.rpc.handle('attachments.finish', input => accepted(async () => {
      const { id, bytes: length } = z.object({ id: z.string().uuid(), bytes: z.number().int().nonnegative() }).strict().parse(input)
      const upload = uploads.get(id)
      if (!upload || upload.bytes !== length) throw new Error('Attachment upload is incomplete')
      const file = await api.storage.exportFile(await fs.storageLocation(upload.spool, 'write', api))
      try {
        const attachment = await importAttachmentFile({ ...upload.metadata, fileHandle: file.handle }, api)
        uploads.delete(id)
        await fs.rm(upload.spool, { force: true }, api)
        return attachment
      } finally { await api.files.release([file.handle]) }
    })),
    api.rpc.handle('attachments.abort', input => accepted(async () => {
      const { id } = z.object({ id: z.string().uuid() }).strict().parse(input); const upload = uploads.get(id); uploads.delete(id); if (upload) await fs.rm(upload.spool, { force: true }, api) }))
  ]
  const offActivity = api.rpc.handle('activity.request', input => accepted(async () => {
    const { method, payload } = z.object({ method: z.enum(['append', 'output', 'readOutput', 'list']), payload: z.unknown() }).strict().parse(input)
    return activityRequest(method, payload)
  }))
  const offRuntime = [
    api.rpc.handle('harness.available', () => accepted(() => api.process.available())),
    api.rpc.handle('harness.steer', input => accepted(async () => steerRuntime(input))),
    api.rpc.handle('harness.respond', input => accepted(async () => respondToRuntime(input))),
    api.rpc.handleOperation('harness.run', (input, context) => accepted(() => runNativeRuntime(input, context)))
  ]
  const offProjectOperations = [
    api.rpc.handleOperation('project.file', (input, context) => accepted(() => projectRequest('file', input, context.api, context.id))),
    api.rpc.handleOperation('project.command', (input, context) => accepted(() => executeProjectCommand(input, context)))
  ]
  const offProjects = api.rpc.handle('projects.request', input => accepted(async () => {
    const { method, payload } = z.object({ method: z.enum(['list', 'create', 'context', 'execution', 'update', 'addFolder', 'removeFolder', 'delete', 'file']), payload: z.unknown().optional() }).strict().parse(input)
    const result = await projectRequest(method, payload)
    if (['create', 'update', 'addFolder', 'removeFolder', 'delete'].includes(method)) api.rpc.emit('projects.changed', { method, id: (payload as { id?: string } | undefined)?.id })
    return result
  }))
  const offToolbox = api.rpc.handle('skills.toolbox', input => accepted(() => toolboxRequest(input)))
  const offSkills = api.rpc.handle('skills.run', (input) => accepted(async () => {
    const parsed = skillRequestSchema.safeParse(input)
    if (!parsed.success) throw new Error(t('assistant.backend.invalidRequest'))
    return { output: await runSkill(VAULT_ROOT, parsed.data.runnable, parsed.data.args) }
  }))
  const offEmbeddings = api.rpc.handle('embeddings.compute', input => accepted(() => computeEmbeddings(input)))
  const offEmbeddingsV2 = api.rpc.handle('embeddings.computeV2', input => accepted(() => computeEmbeddingsV2(input)))
  const disposers = Object.entries({ ai: aiDriver, channels: channelsDriver }).flatMap(([namespace, methods]) => Object.entries(methods).map(([name, method]) => {
    return api.rpc.handle(`${namespace}.${name}`, (input) => accepted(async () => {
    const parsed = method.schema.safeParse(input)
    if (!parsed.success) throw new Error(t('assistant.backend.invalidRequest'))
    const payload = parsed.data
    if (namespace === 'ai' && ['deleteChat', 'clearChat'].includes(name)) await runtime.coordinator.remove((payload as { id: string }).id)
    return method.run(VAULT_ROOT, payload)
    }))
  }))
  return () => {
    if (disposal) return disposal
    active = false
    offSessions.forEach(dispose => dispose())
    const sessions = runtime.close()
    closeBackend(api)
    offRuntime.forEach(dispose => dispose())
    offProjectOperations.forEach(dispose => dispose())
    const processes = stopProjectProcesses()
    offAttachments.forEach(dispose => dispose()); uploads.clear(); offAi(); offProjects(); offActivity(); offToolbox(); offSkills(); offEmbeddings(); offEmbeddingsV2(); disposers.forEach(dispose => dispose())
    const runs = cancelAllRuns()
    cancelAllHarnessRuns()
    const channels = Promise.allSettled([channelManager.stopAll()])
    return disposal = (async () => {
      await sessions
      await processes
      await startup
      const channelResult = await channels
      while (pending.size) await Promise.allSettled([...pending])
      await runs
      await cancelAllRuns()
      await drainBackgroundOperations(api)
      await releaseFileAccess(api)
      if (channelResult[0].status === 'rejected') throw channelResult[0].reason
    })()
  }
}
