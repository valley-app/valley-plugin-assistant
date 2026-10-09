import { commandRegistrar, assistantResults } from './commandResults'
import { uiText } from './localization'
import { registerHarnessCommands } from './harnessCommands'
import type { ValleyPluginApi } from './api'
import type { AiChatThread, CustomCommand } from './types'
import type { SessionSnapshot } from './contracts/execution'

import { supportedEfforts } from './models'
import { getStore } from './store'

const object = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(uiText('assistant.error.inputObject'))
  return raw as Record<string, unknown>
}
const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(uiText('assistant.error.fieldRequired', { field: name }))
  return value.trim()
}
const stringSchema = { type: 'string', minLength: 1 }
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })

export async function readConversation(api: ValleyPluginApi, id: string): Promise<AiChatThread> {
  const store = getStore(api)
  const active = store.getSnapshot().active
  const retained = store.retainedThread(id) ?? (active?.id === id ? active : undefined)
  if (retained) return retained
  const result = await api.assistant.readChat(id)
  if (!result.ok) throw new Error(result.error || uiText('assistant.error.readConversation'))
  if (!result.data?.thread?.id) throw new Error(uiText('assistant.error.missingConversation'))
  return result.data.thread
}

function chatPatch(raw: unknown): Partial<AiChatThread> {
  const values = object(raw)
  if (!Object.keys(values).length || Object.keys(values).some((key) => !['title', 'pinned', 'model', 'profileId', 'attachmentParser', 'commands'].includes(key))) throw new Error(uiText('assistant.error.editableProperties'))
  const patch: Partial<AiChatThread> = {}
  if ('title' in values) patch.title = text(values.title, 'title')
  if ('pinned' in values) {
    if (typeof values.pinned !== 'boolean') throw new Error(uiText('assistant.error.pinnedBoolean'))
    patch.pinned = values.pinned
  }
  for (const key of ['profileId', 'attachmentParser'] as const) if (key in values) {
    if (typeof values[key] !== 'string' && values[key] !== null) throw new Error(uiText('assistant.error.nullableString', { field: key }))
    patch[key] = typeof values[key] === 'string' && values[key] ? values[key] : undefined
  }
  if ('model' in values) {
    if (values.model === null) patch.model = null
    else {
      const model = object(values.model)
      patch.model = { provider: text(model.provider, 'model.provider'), model: text(model.model, 'model.model'), ...(model.connectionId ? { connectionId: text(model.connectionId, 'model.connectionId') } : {}) }
    }
  }
  if ('commands' in values) {
    if (!Array.isArray(values.commands)) throw new Error(uiText('assistant.error.commandsArray'))
    patch.commands = values.commands.map((raw) => {
      const command = object(raw)
      return { name: text(command.name, 'command.name'), prompt: text(command.prompt, 'command.prompt'), ...(typeof command.description === 'string' ? { description: command.description } : {}) } satisfies CustomCommand
    })
  }
  return patch
}

async function refreshConversation(api: ValleyPluginApi, id: string): Promise<void> {
  const store = getStore(api)
  await store.reloadThreads()
  if (store.getSnapshot().active?.id === id) await store.openChat(id, false)
}

async function saveConversation(api: ValleyPluginApi, thread: AiChatThread): Promise<void> {
  await getStore(api).saveThread(thread)
  await refreshConversation(api, thread.id)
}

export async function updateConversation(api: ValleyPluginApi, id: string, patch: Partial<AiChatThread>) {
  const values = chatPatch(Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value === undefined ? null : value])))
  if (getStore(api).getSnapshot().busy) throw new Error(uiText('assistant.error.waitEdit'))
  const before = await readConversation(api, id)
  const after = { ...before, ...values, ...('title' in values ? { titleOrigin: 'manual' as const, titleRevision: (before.titleRevision ?? 0) + 1 } : {}), updatedAt: Date.now() }
  if ('model' in values && !supportedEfforts(after.model, getStore(api).getSnapshot().config?.connections).includes(after.reasoningEffort!)) after.reasoningEffort = undefined
  await saveConversation(api, after)
  return { value: after, revert: { label: `Update ${before.title}`, run: () => saveConversation(api, before), reapply: () => saveConversation(api, after) } }
}

export async function changeConversation(api: ValleyPluginApi, id: string, operation: 'clear-chat' | 'delete-chat') {
  const store = getStore(api)
  await readConversation(api, id)
  if (store.getSnapshot().busy) throw new Error(uiText('assistant.error.stopClear'))
  if (operation === 'clear-chat') await store.clearChat(id)
  else await store.deleteChat(id)
  return { value: { id, operation }, revert: null }
}

export function registerAssistantCommands(api: ValleyPluginApi): () => void {
  const store = getStore(api)
  const save = (thread: AiChatThread): Promise<void> => saveConversation(api, thread)
  const update = (id: string, patch: Partial<AiChatThread>) => updateConversation(api, id, patch)
  const idInput = { schema: schema({ id: stringSchema }, ['id']), parse: (raw: unknown) => ({ id: text(object(raw).id, 'id') }), fromCli: (args: string[]) => ({ id: args[0] }) }
  const patchSchema = schema({ title: stringSchema, pinned: { type: 'boolean' }, model: { anyOf: [{ type: 'null' }, schema({ provider: stringSchema, model: stringSchema, connectionId: stringSchema }, ['provider', 'model'])] }, profileId: { type: ['string', 'null'] }, attachmentParser: { type: ['string', 'null'] }, commands: { type: 'array', items: schema({ name: stringSchema, prompt: stringSchema, description: { type: 'string' } }, ['name', 'prompt']) } })
  const offs = [
    registerHarnessCommands(api),
    commandRegistrar(api)({
      id: 'providers-reload', outputSchema: assistantResults['providers-reload'],
      label: 'Providers: Reload', labelKey: 'assistant.command.reloadProviders',
      sideEffect: 'read',
      usage: 'providers reload',
      run: async () => { const response = await api.assistant.providerStatus(); if (!response.ok || !response.data) throw new Error(response.error || 'Provider status unavailable'); return response.data },
      formatCli: (value) => uiText('assistant.providers.reloaded', { count: (value as { providers: Array<{ configured: boolean }> }).providers.filter((provider) => provider.configured).length })
    }),
    commandRegistrar(api)({ id: 'list-chats', outputSchema: assistantResults['list-chats'], label: 'Assistant: List conversations', labelKey: 'assistant.command.listChats', paletteSafe: false, sideEffect: 'read', run: async () => { await store.reloadThreads(); return store.getSnapshot().threads } }),
    commandRegistrar(api)({ id: 'read-chat', outputSchema: assistantResults['read-chat'], label: 'Assistant: Read a conversation', labelKey: 'assistant.command.readChat', paletteSafe: false, sideEffect: 'read', input: idInput, run: ({ id }) => readConversation(api, id) }),
    commandRegistrar(api)({ id: 'open-chat', outputSchema: assistantResults['open-chat'], label: 'Assistant: Open a conversation', labelKey: 'assistant.command.openChat', paletteSafe: false, sideEffect: 'read', input: idInput, run: async ({ id }) => { await readConversation(api, id); await store.openChat(id); api.workspace.openMainTab(); return { id } } }),
    commandRegistrar(api)({ id: 'create-chat', outputSchema: assistantResults['create-chat'], label: 'Assistant: Create a saved conversation', labelKey: 'assistant.command.createChat', paletteSafe: false, sideEffect: 'write', input: { schema: schema({ title: stringSchema }, ['title']), parse: (raw) => ({ title: text(object(raw).title, 'title') }) }, preview: (input) => input, run: async ({ title }) => {
      const now = Date.now()
      const thread: AiChatThread = { id: `chat-${crypto.randomUUID()}`, title, createdAt: now, updatedAt: now, messages: [] }
      await save(thread)
      return { value: thread, revert: { label: `Create ${title}`, run: () => store.deleteChat(thread.id), reapply: () => save(thread) } }
    } }),
    commandRegistrar(api)({ id: 'update-chat', outputSchema: assistantResults['update-chat'], label: 'Assistant: Update conversation properties', labelKey: 'assistant.command.updateChat', paletteSafe: false, sideEffect: 'write', input: { schema: schema({ id: stringSchema, patch: patchSchema }, ['id', 'patch']), parse: (raw) => { const value = object(raw); return { id: text(value.id, 'id'), patch: chatPatch(value.patch) } } }, revision: async ({ id }) => (await readConversation(api, id)).updatedAt, preview: (input) => input, run: ({ id, patch }) => update(id, patch) }),
    commandRegistrar(api)({ id: 'update-properties', outputSchema: assistantResults['update-properties'], label: 'Assistant: Edit Properties', labelKey: 'assistant.command.updateProperties', paletteSafe: false, sideEffect: 'write', input: { schema: schema({ subject: { type: 'object' }, values: patchSchema }, ['subject', 'values']), parse: (raw) => { const value = object(raw); const subject = object(value.subject); if (subject.pluginId !== api.pluginId) throw new Error(uiText('assistant.error.wrongPropertyOwner')); return { id: text(object(subject.item).id, 'subject.item.id'), patch: chatPatch(value.values) } } }, revision: async ({ id }) => (await readConversation(api, id)).updatedAt, preview: (input) => input, run: ({ id, patch }) => update(id, patch) }),
    ...(['clear-chat', 'delete-chat'] as const).map((operation) => commandRegistrar(api)({ id: operation, outputSchema: assistantResults[operation], label: `Assistant: ${operation === 'clear-chat' ? 'Clear' : 'Delete'} a conversation`, labelKey: operation === 'clear-chat' ? 'assistant.command.clearChat' : 'assistant.command.deleteChat', paletteSafe: false, sideEffect: 'write', input: idInput, revision: async ({ id }) => (await readConversation(api, id)).updatedAt, preview: ({ id }) => ({ id, operation }), run: ({ id }) => changeConversation(api, id, operation) })),
    commandRegistrar(api)({ id: 'send-message', outputSchema: assistantResults['send-message'], label: 'Assistant: Send a message to a conversation', labelKey: 'assistant.command.sendMessage', paletteSafe: false, sideEffect: 'write', input: { schema: schema({ id: stringSchema, text: stringSchema }, ['id', 'text']), parse: (raw) => { const value = object(raw); return { id: text(value.id, 'id'), text: text(value.text, 'text') } } }, preview: (input) => input, run: async ({ id, text: message }, context) => {
      const thread = await readConversation(api, id)
      if (thread.source) throw new Error(uiText('assistant.error.remoteMessage'))
      await store.openChat(id)
      const session = await api.backend.callOperation<SessionSnapshot>('command.session.submit', { id: crypto.randomUUID(), conversationId: id, text: message }, { cancellation: context.cancellation })
      if (session.error || session.state === 'FAILED' || session.state === 'INTERRUPTED') throw new Error(session.error ?? 'Conversation did not complete')
      return { value: session.thread ?? await readConversation(api, id), revert: null }
    } }),
    commandRegistrar(api)({ id: 'stop-chat', outputSchema: assistantResults['stop-chat'], label: 'Assistant: Stop a conversation run', labelKey: 'assistant.command.stopChat', paletteSafe: false, sideEffect: 'execute', input: idInput, run: ({ id }) => { store.stop(id); return { id, stopped: true } } }),
    commandRegistrar(api)({ id: 'read-memory', outputSchema: assistantResults['read-memory'], label: 'Assistant: Read conversation memory', labelKey: 'assistant.command.readMemory', paletteSafe: false, sideEffect: 'read', input: idInput, run: async ({ id }) => { await readConversation(api, id); const result = await api.assistant.readMemory(id); if (!result.ok) throw new Error(result.error || uiText('assistant.error.readMemory')); return result.data } })
  ]
  return () => offs.forEach((off) => off())
}
