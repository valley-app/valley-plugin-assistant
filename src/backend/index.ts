import * as fs from './filesystem'
import { effectiveSettings } from './configuration/settings'
import { AssistantRuntime } from './engine/service'
import { configurationHandlers } from './configuration'
import { readConfig } from './store'
import { rebuildChatSearch } from './threads'
import { steerRuntime, runNativeRuntime, respondToRuntime } from './runtimes'
import { z } from 'zod'
import { executeProjectCommand, stopProjectProcesses } from './projectExecution'
import { projectRequest, resumeProjectCleanup } from './projects'
import { activityRequest } from './activity'
import { importAttachmentFile, resumeAttachmentCleanup, discardAttachment, importTransferredAttachments } from './attachments'
import type { PluginBackendApi } from '@valley/plugin-sdk'
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
  const offSessions = [
    ...Object.entries(configurationHandlers(VAULT_ROOT)).map(([method, handler]) => api.rpc.handle(method, input => accepted(() => handler(input)))),
    api.rpc.handle('session.channelSend', input => accepted(async () => runtime.sendAsChannel(sessionInput.extend({ id: z.string().uuid(), text: z.string().trim().min(1).max(500000) }).strict().parse(input)))),
    api.rpc.handle('session.snapshot', input => accepted(async () => runtime.coordinator.snapshot(sessionInput.parse(input).conversationId))),
    api.rpc.handle('session.submit', input => accepted(async () => { const value = z.object({ id: z.string().min(1).max(512), conversationId: z.string().min(1).max(256), text: z.string().max(500000), thread: chatThread.optional(), origin: z.literal('voice').optional(), attachments: z.array(z.object({ id: z.string().uuid(), path: z.string().min(1).max(4096), fileName: z.string().min(1).max(256), kind: z.enum(['image', 'pdf', 'audio', 'file']), mime: z.string().max(128).optional() }).strict()).max(32).optional() }).strict().parse(input); return runtime.submit(value) })),
    api.rpc.handle('session.interruptVoice', input => accepted(async () => { const id = sessionInput.parse(input).conversationId; if (['INFERRING', 'PREPARING'].includes(runtime.coordinator.snapshot(id)?.state ?? '')) await runtime.coordinator.stop(id) })),
    api.rpc.handle('session.stop', input => accepted(() => runtime.coordinator.stop(sessionInput.parse(input).conversationId))),
    api.rpc.handle('session.resume', input => accepted(() => runtime.coordinator.resume(sessionInput.parse(input).conversationId))),
    api.rpc.handle('session.queue', input => accepted(async () => { const value = sessionInput.extend({ turnId: z.string(), patch: z.object({ text: z.string().optional(), editing: z.boolean().optional(), index: z.number().int().nonnegative().optional(), remove: z.boolean().optional() }) }).strict().parse(input); await runtime.coordinator.edit(value.conversationId, value.turnId, value.patch) })),
    api.rpc.handle('session.steer', input => accepted(async () => { const value = sessionInput.extend({ turnId: z.string() }).strict().parse(input); await runtime.coordinator.steer(value.conversationId, value.turnId) })),
    api.rpc.handle('session.mode', input => accepted(async () => { const value = sessionInput.extend({ mode: z.literal('plan') }).strict().parse(input); await runtime.coordinator.change(value.conversationId, async thread => { thread.mode = 'plan'; if (thread.plan) thread.plan.status = 'changes'; return {} }) })),
    api.rpc.handle('plan.approve', input => accepted(async () => { const value = sessionInput.extend({ planId: z.string().uuid(), revision: z.number().int().positive(), artifactHash: z.string().length(64), instructionSnapshotId: z.string().length(64) }).strict().parse(input); await runtime.approve(value.conversationId, value, 'local-user') }))
  ]
  const uploads = new Map<string, { metadata: { fileName: string; mime?: string; kind: 'image' | 'pdf' | 'audio' | 'file'; folder?: string }; bytes: number; spool: string; createdAt: number }>()
  const uploadSchema = z.object({ fileName: z.string().min(1).max(256), mime: z.string().max(128).optional(), kind: z.enum(['image', 'pdf', 'audio', 'file']), folder: z.string().max(4096).optional() }).strict()
  const offAttachments = [
    api.rpc.handle('attachments.discard', input => accepted(async () => { const { id } = z.object({ id: z.string().uuid() }).strict().parse(input); await discardAttachment(id) })),
    api.rpc.handle('attachments.begin', input => accepted(async () => {
      const metadata = uploadSchema.parse(input)
      for (const [id, upload] of uploads) if (Date.now() - upload.createdAt > 600000) uploads.delete(id)
      if (uploads.size >= 4) throw new Error('Too many attachment uploads')
      const id = crypto.randomUUID()
      const spool = `${VAULT_ROOT}/.valley/plugins/data/assistant/media/inbound/upload-${id}.part`
      await fs.mkdir(spool.slice(0, spool.lastIndexOf('/')), { recursive: true })
      uploads.set(id, { metadata, bytes: 0, spool, createdAt: Date.now() })
      return id
    })),
    api.rpc.handle('attachments.chunk', input => accepted(async () => {
      const { id, offset, base64 } = z.object({ id: z.string().uuid(), offset: z.number().int().nonnegative(), base64: z.string().max(1400000) }).strict().parse(input)
      const upload = uploads.get(id)
      if (!upload || upload.bytes !== offset) throw new Error('Attachment upload is unavailable or out of order')
      const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
      if (upload.bytes + bytes.length > (await effectiveSettings(VAULT_ROOT)).importMaxBytes) throw new Error('Attachment exceeds the configured import limit')
      await api.storage.writeBytes(await fs.storageLocation(upload.spool), base64, offset > 0)
      upload.bytes += bytes.length
    })),
    api.rpc.handle('attachments.finish', input => accepted(async () => {
      const { id, bytes: length } = z.object({ id: z.string().uuid(), bytes: z.number().int().nonnegative() }).strict().parse(input)
      const upload = uploads.get(id)
      if (!upload || upload.bytes !== length) throw new Error('Attachment upload is incomplete')
      const file = await api.storage.exportFile(await fs.storageLocation(upload.spool))
      try {
        const attachment = await importAttachmentFile({ ...upload.metadata, fileHandle: file.handle })
        uploads.delete(id)
        await fs.rm(upload.spool, { force: true })
        return attachment
      } finally { await api.files.release([file.handle]) }
    })),
    api.rpc.handle('attachments.abort', input => accepted(async () => { const { id } = z.object({ id: z.string().uuid() }).strict().parse(input); const upload = uploads.get(id); uploads.delete(id); if (upload) await fs.rm(upload.spool, { force: true }) }))
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
  const disposers = Object.entries({ ai: aiDriver, channels: channelsDriver }).flatMap(([namespace, methods]) => Object.entries(methods).map(([name, method]) => api.rpc.handle(`${namespace}.${name}`, (input) => accepted(async () => {
    const parsed = method.schema.safeParse(input)
    if (!parsed.success) throw new Error(t('assistant.backend.invalidRequest'))
    const payload = parsed.data
    if (namespace === 'ai' && ['deleteChat', 'clearChat'].includes(name)) await runtime.coordinator.remove((payload as { id: string }).id)
    return method.run(VAULT_ROOT, payload)
  }))))
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
