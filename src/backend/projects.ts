import { z } from 'zod'
import path from 'path-browserify'
import type { DatasetRecord, PluginBackendOperationContext } from '@valley/plugin-sdk'
import type { ProjectRoot, ProjectFile } from '@valley/plugin-sdk/pluginExecution'
import type { FileBaseline } from '@valley/plugin-sdk/types'
import type { AssistantProject } from '../types'
import { backendApi, VAULT_ROOT } from './runtime'
import { datasetRows } from './attachments'
import { listChats, readChat, saveChat } from './threads'
import { cancelChatRuns } from './engine'
import { persistActivityText, appendActivity } from './activity'
import { assertChatWritable } from './attachments'
import { runExclusive } from './fileQueue'
import { projectConfiguration } from './configuration/conversations'
const projects = (api: PluginBackendOperationContext['api'] = backendApi()) => api.data.dataset<AssistantProject & DatasetRecord>('projects')
const id = z.string().uuid()
export async function projectFor(projectId: string, api: PluginBackendOperationContext['api'] = backendApi()): Promise<AssistantProject> {
  const project = await projects(api).get({ id: projectId })
  if (!project || project.deleting) throw new Error('Project is unavailable')
  return projectConfiguration(VAULT_ROOT, project, undefined, undefined, api)
}
export async function rootsFor(project: AssistantProject, api: PluginBackendOperationContext['api'] = backendApi()): Promise<ProjectRoot[]> {
  const roots = await api.projects.roots(project.id)
  return roots.sort((a, b) => (project.folders.indexOf(a.id) < 0 ? Infinity : project.folders.indexOf(a.id)) - (project.folders.indexOf(b.id) < 0 ? Infinity : project.folders.indexOf(b.id)))
}
export async function executionContext(chatId: string, api: PluginBackendOperationContext['api'] = backendApi()) {
  const thread = await readChat(VAULT_ROOT, chatId, api)
  if (!thread) throw new Error('Conversation is unavailable')
  const access = await api.projects.access()
  const project = thread.projectId ? await projectFor(thread.projectId, api) : undefined
  const selected = project ? (await rootsFor(project, api))[0] : undefined
  const relative = selected ? path.relative(access.root.path, selected.path) : ''
  const cwd = selected && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative) ? selected.path : access.cwd
  return { ...access, cwd, project, roots: [access.root] }
}
export function executionFile(context: Awaited<ReturnType<typeof executionContext>>, rootId: string, file: string): ProjectFile {
  if (rootId !== context.root.id) throw new Error('Folder access changed; start a new turn')
  const absolute = path.resolve(context.cwd, file.startsWith('~/') ? path.join(context.home, file.slice(2)) : file)
  const relative = path.relative(context.root.path, absolute)
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('This path requires Full access')
  return { rootId, path: relative }
}
export async function projectRequest(method: string, payload: unknown, api: PluginBackendOperationContext['api'] = backendApi(), operationId?: string): Promise<unknown> {
  if (method === 'execution') {
    const { chatId } = z.object({ chatId: z.string().min(1).max(256) }).strict().parse(payload)
    return executionContext(chatId, api)
  }
  if (method === 'list') return Promise.all((await datasetRows(projects(api))).filter(project => !project.deleting).map(project => projectConfiguration(VAULT_ROOT, project, undefined, undefined, api)))
  if (method === 'create') {
    const { name } = z.object({ name: z.string().trim().min(1).max(256) }).strict().parse(payload)
    const project: AssistantProject = { id: crypto.randomUUID(), name, instructions: '', folders: [], deleting: false, createdAt: Date.now(), updatedAt: Date.now() }
    await projects(api).insert({ ...project })
    return projectConfiguration(VAULT_ROOT, project, undefined, undefined, api)
  }
  if (method === 'file') {
    const input = z.object({ chatId: z.string().min(1).max(256), operation: z.enum(['list', 'read', 'write']), rootId: id, path: z.string().max(4096),
      activity: z.object({ runId: z.string(), callId: z.string() }).optional(), content: z.string().max(4 * 1024 * 1024).optional(), expected: z.object({ hash: z.string(), mtimeMs: z.number(), size: z.number() }).nullable().optional() }).strict().parse(payload)
    await assertChatWritable(input.chatId, api)
    const context = await executionContext(input.chatId, api)
    const file = executionFile(context, input.rootId, input.path)
    let events = Promise.resolve(), eventFailure: unknown
    const off = input.activity && operationId ? api.projects.onActivity(event => {
      if (event.runId === operationId) events = events.then(() => appendActivity(input.chatId, { ...event, runId: input.activity!.runId, parentCallId: input.activity!.callId })).catch(error => { eventFailure ??= error })
    }) : () => {}
    try {
    if (input.operation === 'write') {
      if (input.content === undefined || input.expected === undefined) throw new Error('Read the file and provide its baseline before writing')
      const before = input.expected ? await api.projects.read(file) : { content: '' }
      const result = await api.projects.write({ ...file, content: input.content, expected: input.expected as FileBaseline | null })
      if (result.ok && input.activity) {
        const oldLines = before.content.split('\n'), newLines = input.content.split('\n')
        let prefix = 0, suffix = 0
        while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++
        while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines.at(-suffix - 1) === newLines.at(-suffix - 1)) suffix++
        const start = Math.max(0, prefix - 3), oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 3), newEnd = Math.min(newLines.length, newLines.length - suffix + 3)
        const diff = [`--- ${input.path}`, `+++ ${input.path}`, `@@ -${start + 1},${oldEnd - start} +${start + 1},${newEnd - start} @@`, ...oldLines.slice(start, prefix).map(line => ' ' + line), ...oldLines.slice(prefix, oldLines.length - suffix).map(line => '-' + line), ...newLines.slice(prefix, newLines.length - suffix).map(line => '+' + line), ...newLines.slice(newLines.length - suffix, newEnd).map(line => ' ' + line)].join('\n')
        const diffRef = await persistActivityText(input.chatId, input.activity.runId, input.activity.callId + ':diff', diff)
        await appendActivity(input.chatId, { ...input.activity, name: 'project_write_file', state: 'running', timestamp: Date.now(), arguments: { path: input.path, rootId: input.rootId }, diffRef })
      }
      return result
    }
    return await api.projects[input.operation](file)
    } finally { off(); await events; if (eventFailure) throw eventFailure }
  }
  const input = z.object({ id, name: z.string().trim().min(1).max(256).optional(), instructions: z.string().max(100000).optional(), expectedRevision: z.number().int().nonnegative().optional(), rootId: id.optional() }).strict().parse(payload)
  return runExclusive(`project:${input.id}`, async () => {
    const project = await projectFor(input.id, api)
    if (method === 'context') return { project, roots: await rootsFor(project, api) }
    if (method === 'update') {
      await projectConfiguration(VAULT_ROOT, project, { name: input.name, instructions: input.instructions }, input.expectedRevision, api)
      await projects(api).update({ id: input.id }, { updatedAt: Date.now() })
    } else if (method === 'addFolder') {
      const root = await api.projects.pick({ projectId: project.id })
      if (root) await projects(api).update({ id: project.id }, { folders: [...new Set([...project.folders, root.id])], updatedAt: Date.now() })
    } else if (method === 'removeFolder') {
      if (!input.rootId || !(await rootsFor(project, api)).some(root => root.id === input.rootId)) throw new Error('Unknown project folder')
      for (const thread of await listChats(VAULT_ROOT, true)) if (thread.projectId === project.id) await cancelChatRuns(thread.id)
      await api.projects.revoke(input.rootId)
      await projects(api).update({ id: project.id }, { folders: project.folders.filter(rootId => rootId !== input.rootId), updatedAt: Date.now() })
    } else if (method === 'delete') {
      await projects(api).update({ id: project.id }, { deleting: true })
      await finishProjectDeletion(project)
      return null
    } else throw new Error('Unknown project operation')
    return { project: await projectFor(input.id, api), roots: await rootsFor(await projectFor(input.id, api), api) }
  })
}

async function finishProjectDeletion(project: AssistantProject): Promise<void> {
  for (const summary of await listChats(VAULT_ROOT, true)) {
    if (summary.projectId !== project.id) continue
    await cancelChatRuns(summary.id)
    const thread = await readChat(VAULT_ROOT, summary.id)
    if (thread) { delete thread.projectId; await saveChat(VAULT_ROOT, thread) }
  }
  for (const root of await rootsFor(project)) await backendApi().projects.revoke(root.id)
  await projects().delete({ id: project.id })
}
export async function resumeProjectCleanup(): Promise<void> {
  for (const project of await datasetRows(projects(), { deleting: true })) await runExclusive(`project:${project.id}`, () => finishProjectDeletion(project))
}
