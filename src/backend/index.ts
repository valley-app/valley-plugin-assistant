import { createWorkflowAdapter } from './workflow'
import * as fs from './filesystem'
import { effectiveSettings, readSettingsDocument, saveSettings, settingsSchema } from './configuration/settings'
import { AssistantRuntime } from './engine/service'
import { configurationHandlers } from './configuration'
import { configurationDomainHandlers, configurationDomainSchemas } from './configuration/domainCommands'
import { readConfig } from './store'
import { rebuildChatSearch, listChats, readChat, renameChat, deleteChat, clearChat, setChatPinned, saveChat, captureChat, chatRevision, restoreChat } from './threads'
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
import { transportValue } from './transport'
import { admitTurn } from './engine/responsiveness'
import { touchesEffects } from './engine/coordinator'
import type { TurnSubmission } from '../contracts/execution'
import type { OutboundDelivery } from './channels/deliveryQueue'
import type { DurableRecord } from './persistence/repositories'
import { createSealedTestOperations } from './sealedTest'
export function register(api: PluginBackendApi): () => Promise<void> {
  const workflow = createWorkflowAdapter(api)
  initBackend(api)
  const runtime = new AssistantRuntime(api)
  channelManager.bindRuntime({ repository: runtime.repository, onInbound: (id, message) => runtime.inbound(id, { ...message, channelId: id, ts: message.receivedAt ?? Date.now() }).then(() => {}), onLifecycle: async (id, event) => { if (event.type === 'receipt' && event.state) await runtime.channels.deliveries.providerReceipt(id, event.providerMessageId, event.state, event.error) }, onAction: async (_id, action, actor) => { if (action.kind === 'plan.approve') await runtime.approve(action.conversationId, action, `${actor.channelId}:${actor.chatRef}:${actor.senderId}`); else {
    await runtime.coordinator.change(action.conversationId, async thread => { if (thread.plan?.id !== action.planId || thread.plan.revision !== action.revision) throw new Error('Plan changed'); thread.plan.status = 'changes'; thread.mode = 'plan'; return {} })
    // Same as the in-app "Change" button: confirm the tap and ask what to change, instead of going silent.
    const thread = runtime.coordinator.snapshot(action.conversationId)?.thread
    if (thread?.source && thread.channelId && thread.chatRef) await runtime.channels.send({ id: `plan-refine:${action.planId}:${action.revision}`, conversationId: thread.id, destination: { kind: thread.source, conversationId: thread.id, channelId: thread.channelId, chatRef: thread.chatRef, topicId: thread.channelTopicId, chatType: thread.channelChatType }, content: { type: 'text', text: 'Okay, the plan stays open. Tell me what to change.' } })
  } } })
  const offAi = api.ai.onStream(event => relayAiStream(api, event))
  let active = true
  let disposal: Promise<void> | undefined
  // Window and command reads share one bound; a user's turn has its own few slots on top, so a burst of reads can never refuse a message.
  const pending = new Map<Promise<unknown>, { turn: boolean; startedAt: number }>()
  const PENDING_LIMIT = 64, TURN_RESERVE = 8
  // A failed start names its step and reaches the user as one plain message (the host drops backend logs); every request then gets the same message.
  let step = 'importing attachments'
  const ready = importTransferredAttachments().then(() => { step = 'resuming cleanup'; return Promise.all([resumeAttachmentCleanup(), resumeProjectCleanup()]) }).then(() => { step = 'indexing chats'; return rebuildChatSearch(VAULT_ROOT) }).then(() => { step = 'reading settings'; return readConfig(VAULT_ROOT) }).then(() => { step = 'restoring conversations'; return runtime.restore() })
    .catch(error => { throw Object.assign(new Error(t('assistant.backend.startupFailed', { step, value: error instanceof Error ? error.message : String(error) })), { code: 'ASSISTANT_NOT_STARTED', outcome: 'not-applied', retryable: false }) })
  void ready.catch(error => api.rpc.emit('backendError', error.message))
  const accepted = <T>(operation: () => Promise<T>, turn = false): Promise<T> => {
    if (!active) return Promise.reject(new Error('Assistant backend is closing'))
    const entries = [...pending.values()], turns = entries.filter(entry => entry.turn).length
    if (turn ? turns >= TURN_RESERVE : entries.length - turns >= PENDING_LIMIT) {
      const now = Date.now()
      return Promise.reject(Object.assign(new Error('Too many Assistant requests are pending'), { code: 'ASSISTANT_BUSY', outcome: 'not-applied', retryable: true,
        details: { pending: entries.length, turns, oldestAgeMs: entries.reduce((oldest, entry) => Math.max(oldest, now - entry.startedAt), 0) } }))
    }
    const task = ready.then(() => { if (backendApi() !== api) throw new Error('Assistant backend changed before request'); return operation() }).then(transportValue)
    pending.set(task, { turn, startedAt: Date.now() })
    void task.then(() => pending.delete(task), () => pending.delete(task))
    return task
  }
  const startup = ready.then(() => { if (active) return channelManager.ensureStarted(VAULT_ROOT).then(() => channelManager.recoverInbound()) }, () => undefined).catch((error) => { if (active) api.rpc.emit('backendError', String(error)) })
  const sessionInput = z.object({ conversationId: z.string().min(1).max(256) })
  const admitSubmission = (input: TurnSubmission, context: PluginBackendOperationContext, owner: PluginBackendOperationContext['api']) => admitTurn(admission => accepted(async () => {
    admission.check()
    const target = await admission.step('binding the originating application window', () => context.api.agent.captureTarget())
    return runtime.submit({ ...input, ...(target ? { targetReference: target.reference } : {}) }, owner, admission)
  }, true), context.cancellation)
  // send-message is owned by this backend, not by a window: its execution id is the turn id, so a reload neither cancels nor repeats the turn.
  const sendEnvelope = z.object({ input: z.object({ id: z.string().trim().min(1).max(256), text: z.string().trim().min(1).max(500000) }).strict(), execution: z.object({ id: z.string().min(1).max(512) }).passthrough() })
  const sendInput = (raw: unknown) => { const value = sendEnvelope.safeParse(raw); if (!value.success) throw Object.assign(new Error(value.error.issues[0]?.message ?? 'Invalid message'), { code: 'INVALID_INPUT', outcome: 'not-applied' }); return value.data }
  // A turn that failed before any tool beyond catalog discovery ran changed nothing beyond its own history, so the caller sees a plain failure instead of an unknown outcome.
  const untouched = async (id: string, turnId: string, owner?: PluginBackendOperationContext['api']) => {
    const thread = (await runtime.coordinator.load(id, owner).catch(() => null))?.thread ?? await readChat(VAULT_ROOT, id, owner).catch(() => null)
    const messages = thread?.messages ?? [], start = messages.findIndex(item => item.id === turnId)
    return Boolean(thread) && (start < 0 || !messages.slice(start + 1).some(item => touchesEffects(item, messages)))
  }
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
    'command.session.snapshot': async (input, owner) => runtime.coordinator.load(sessionInput.strict().parse(input).conversationId, owner),
    'command.session.submit': async (input, owner, context) => { if (!context) throw new Error('Authenticated submission is required'); const value = z.object({ id: z.string().min(1).max(512), conversationId: z.string().min(1).max(256), text: z.string().min(1).max(500000) }).strict().parse(input); await admitSubmission(value, context, owner); return runtime.coordinator.waitForTurn(value.conversationId, value.id, context.cancellation) },
    'command.sendMessage': async (raw, owner, context) => {
      if (!context) throw new Error('Authenticated submission is required')
      const { input: { id, text }, execution } = sendInput(raw)
      const thread = await accepted(() => readChat(VAULT_ROOT, id, owner), true).catch((error: unknown) => { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { outcome: 'not-applied' }) })
      if (!thread) throw Object.assign(new Error(t('assistant.error.missingConversation')), { code: 'CONVERSATION_NOT_FOUND', outcome: 'not-applied' })
      if (thread.source) throw Object.assign(new Error(t('assistant.error.remoteMessage')), { code: 'REMOTE_CONVERSATION', outcome: 'not-applied' })
      if (context.cancellation.aborted) throw Object.assign(new Error('The message was cancelled before it was sent'), { code: 'CANCELLED', outcome: 'not-applied' })
      // A cancelled operation's own API refuses every further call, so after a cancel the history is read through the backend's API.
      const settled = async (error: unknown): Promise<never> => { throw await untouched(id, execution.id, context.cancellation.aborted ? undefined : owner) && error && typeof error === 'object' ? Object.assign(error, { outcome: 'not-applied' }) : error }
      const session = await admitSubmission({ id: execution.id, conversationId: id, text, targetFallback: 'sole-window' }, context, owner).then(() => runtime.coordinator.waitForTurn(id, execution.id, context.cancellation)).catch(settled)
      if (session.error || session.state === 'FAILED' || session.state === 'INTERRUPTED') await settled(new Error(session.error ?? 'Conversation did not complete'))
      return { value: session.thread ?? await readChat(VAULT_ROOT, id, owner) }
    },
    'command.sendMessage.reconcile': async (raw, owner) => {
      const { input: { id }, execution } = sendInput(raw)
      const row = await owner.data.dataset<DurableRecord>('turn_queue').get({ id: execution.id })
      if (!row || row.state === 'REMOVED') return { outcome: 'not-applied' }
      const session = await runtime.coordinator.load(id, owner)
      if (row.state === 'COMPLETED') return { outcome: 'applied', value: session?.thread ?? await readChat(VAULT_ROOT, id, owner) }
      const stopped = row.state === 'ACTIVE' && session?.currentTurn?.id === execution.id && ['FAILED', 'INTERRUPTED'].includes(session.state)
      return { outcome: stopped && await untouched(id, execution.id, owner) ? 'not-applied' : 'pending' }
    },
    'command.session.stop': async (input, owner) => { await runtime.coordinator.stop(sessionInput.strict().parse(input).conversationId, owner); return null },
    'command.session.resume': async (input, owner, context) => { const id = sessionInput.strict().parse(input).conversationId; await runtime.coordinator.resume(id, owner); await runtime.coordinator.waitForTurn(id, undefined, context?.cancellation); return null },
    'command.session.queue': async (input, owner, context) => { const value = sessionInput.extend({ turnId: z.string().min(1).max(256), patch: z.object({ text: z.string().max(500000).optional(), editing: z.boolean().optional(), index: z.number().int().nonnegative().optional(), remove: z.boolean().optional() }).strict() }).strict().parse(input); await runtime.coordinator.edit(value.conversationId, value.turnId, value.patch, owner); if (!value.patch.remove && !runtime.coordinator.snapshot(value.conversationId)?.queue.find(turn => turn.id === value.turnId)?.editing) await runtime.coordinator.waitForTurn(value.conversationId, value.turnId, context?.cancellation); return null },
    'command.session.steer': async (input, owner, context) => { const value = sessionInput.extend({ turnId: z.string().min(1).max(256) }).strict().parse(input); await runtime.coordinator.steer(value.conversationId, value.turnId, owner); await runtime.coordinator.waitForTurn(value.conversationId, value.turnId, context?.cancellation); return null },
    'command.session.plan': async (input, owner) => { const value = sessionInput.strict().parse(input); await runtime.coordinator.change(value.conversationId, async thread => { thread.mode = 'plan'; if (thread.plan) thread.plan.status = 'changes'; return {} }, owner); return null }
  }
  for (const name of ['listChats', 'readChat', 'renameChat', 'setChatPinned', 'readMemory'] as const) commandHandlers[`command.${name}`] = async (input, owner) => {
    const method = aiDriver[name], payload = method.schema.parse(input)
    const value = payload as { id: string; title: string; pinned: boolean }
    if (name === 'listChats') return { chats: await listChats(VAULT_ROOT, false, owner) }
    if (name === 'readChat') return { thread: await readChat(VAULT_ROOT, value.id, owner) }
    if (name === 'renameChat') await renameChat(VAULT_ROOT, value.id, value.title, owner)
    if (name === 'setChatPinned') await setChatPinned(VAULT_ROOT, value.id, value.pinned, owner)
    if (name === 'readMemory') return { memory: await readMemory(VAULT_ROOT, (payload as { chatId: string }).chatId, owner) }
    return null
  }
  // deleteChat/clearChat answer with a command receipt whose undo rewrites the captured chat bytes (threads.ts restoreChat).
  const chatId = (raw: unknown) => aiDriver.deleteChat.schema.parse((raw as { input?: unknown } | null)?.input).id
  const capture = async (id: string, owner: PluginBackendOperationContext['api']) => runtime.coordinator.snapshot(id) ? null : captureChat(VAULT_ROOT, id, owner)
  for (const name of ['deleteChat', 'clearChat'] as const) commandHandlers[`command.${name}`] = async (raw, owner) => {
    const id = chatId(raw), snapshot = await capture(id, owner)
    await runtime.coordinator.remove(id, owner)
    await (name === 'deleteChat' ? deleteChat : clearChat)(VAULT_ROOT, id, owner)
    return { value: null, ...(snapshot ? { undo: { snapshot, expectedRevision: await chatRevision(VAULT_ROOT, id, owner), affectedEntities: [id] } } : {}) }
  }
  // Sealed test fixtures only: the forget operations exist only after the sealed-test probe (sealedTest.ts) succeeded and re-check it per call.
  const sealed = createSealedTestOperations(VAULT_ROOT, runtime.coordinator)
  let sealedOperations: Promise<boolean> | undefined
  const probeSealed = () => sealedOperations ??= sealed.sealed(api).then(on => {
    if (!on) sealedOperations = undefined
    else if (active) offSessions.push(...(['captureSession', 'forgetSession', 'captureHarness', 'forgetHarness'] as const).map(name => workflow.operation(`test.${name}`, (input, context) => accepted((): Promise<unknown> => sealed[name](input, context.api)))))
    return on && active
  })
  commandHandlers['command.chat.revision'] = (raw, owner) => chatRevision(VAULT_ROOT, chatId(raw), owner)
  commandHandlers['command.chat.undo'] = async (raw, owner) => { const value = raw as { snapshot?: unknown; execution?: { expectedRevision?: unknown } } | null; await restoreChat(VAULT_ROOT, value?.snapshot, value?.execution?.expectedRevision, owner); return null }
  const offSessions = [
    workflow.operation('chat.capture', (input, context) => accepted(async () => capture(z.object({ id: z.string().min(1).max(256) }).strict().parse(input).id, context.api))),
    api.rpc.handle('test.sealed', () => accepted(probeSealed)),
    workflow.operation('chat.revision', (input, context) => accepted(async () => chatRevision(VAULT_ROOT, z.object({ id: z.string().min(1).max(256) }).strict().parse(input).id, context.api))),
    workflow.operation('chat.restore', (input, context) => accepted(async () => { const value = z.object({ snapshot: z.unknown(), expectedRevision: z.string().length(64) }).strict().parse(input); await restoreChat(VAULT_ROOT, value.snapshot, value.expectedRevision, context.api); return null })),
    workflow.local('workflow.telegram.send', (input, context) => accepted(async () => {
      const value = z.object({ conversationId: z.string().min(1).max(256), text: z.string().trim().min(1).max(500000) }).strict().parse(input)
      context.cancellation.throwIfAborted()
      const thread = await readChat(VAULT_ROOT, value.conversationId, context.api)
      if (thread?.source !== 'telegram') throw Object.assign(new Error('Choose an existing Telegram conversation'), { code: 'PROVIDER_INVALID_INPUT', fatal: true, transient: false, retryable: false })
      const id = context.id, deliveryId = `manual:${value.conversationId}:${id}`
      try { await runtime.sendAsChannel({ ...value, id }, context.api) }
      catch (error) {
        const delivery = await runtime.repository.get<OutboundDelivery>('outbound_deliveries', deliveryId)
        const unknown = delivery?.state === 'UNKNOWN' || delivery?.state === 'DISPATCHING'
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: 'CHANNEL_DELIVERY_FAILED', fatal: true, transient: false, retryable: false, ...(unknown ? { outcome: 'unknown', outcomeUnknown: true } : {}) })
      }
      const delivery = await runtime.repository.get<OutboundDelivery>('outbound_deliveries', deliveryId)
      if (!delivery || !['ACCEPTED', 'DELIVERED', 'READ'].includes(delivery.state) || !delivery.providerMessageIds.length) throw Object.assign(new Error('Telegram has no confirmed provider receipt'), { code: 'CHANNEL_OUTCOME_UNKNOWN', outcome: 'unknown', outcomeUnknown: true, fatal: true, transient: false, retryable: false })
      return { deliveryId: delivery.id, conversationId: value.conversationId, state: delivery.state, providerMessageIds: delivery.providerMessageIds }
    })),
    ...Object.keys(configurationDomainSchemas).map(method => workflow.operation(`command.${method}`, (input, context) => accepted(async () => {
      context.cancellation.throwIfAborted()
      return configurationDomainHandlers(VAULT_ROOT, context.api)[method as keyof typeof configurationDomainSchemas](input)
    }))),
    ...['configuration.status', 'configuration.note', 'configuration.note.set', 'configuration.link', 'configuration.speech', 'configuration.speech.set', 'configuration.conversation', 'configuration.conversation.set', 'configuration.project', 'configuration.project.set'].map(method => workflow.operation(`command.${method}`, (input, context) => accepted(async () => {
      context.cancellation.throwIfAborted()
      return configurationHandlers(VAULT_ROOT, context.api)[method](input)
    }))),
    ...Object.entries(commandHandlers).map(([method, handler]) => workflow.operation(method, (input, context) => ['command.session.submit', 'command.sendMessage'].includes(method) ? handler(input, context.api, context).then(transportValue) : accepted(async () => { context.cancellation.throwIfAborted(); return handler(input, context.api, context) }))),
    ...Object.entries(configurationHandlers(VAULT_ROOT)).map(([method, handler]) => api.rpc.handle(method, input => accepted(() => handler(input)))),
    api.rpc.handle('session.channelSend', input => accepted(async () => runtime.sendAsChannel(sessionInput.extend({ id: z.string().uuid(), text: z.string().trim().min(1).max(500000) }).strict().parse(input), api))),
    api.rpc.handle('session.snapshot', input => accepted(async () => runtime.coordinator.load(sessionInput.parse(input).conversationId))),
    workflow.operation('session.submit', async (input, context) => { const value = z.object({ id: z.string().min(1).max(512), conversationId: z.string().min(1).max(256), text: z.string().max(500000), thread: chatThread.optional(), origin: z.literal('voice').optional(), attachments: z.array(z.object({ id: z.string().uuid(), path: z.string().min(1).max(4096), fileName: z.string().min(1).max(256), kind: z.enum(['image', 'pdf', 'audio', 'file']), mime: z.string().max(128).optional() }).strict()).max(32).optional() }).strict().parse(input); return admitSubmission(value, context, api) }),
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
    workflow.operation('harness.run', (input, context) => accepted(() => runNativeRuntime(input, context)))
  ]
  const offProjectOperations = [
    workflow.operation('project.file', (input, context) => accepted(() => projectRequest('file', input, context.api, context.id))),
    workflow.operation('project.command', (input, context) => accepted(() => executeProjectCommand(input, context)))
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
    workflow.dispose()
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
      while (pending.size) await Promise.allSettled([...pending.keys()])
      await runs
      await cancelAllRuns()
      await drainBackgroundOperations(api)
      await releaseFileAccess(api)
      if (channelResult[0].status === 'rejected') throw channelResult[0].reason
    })()
  }
}
