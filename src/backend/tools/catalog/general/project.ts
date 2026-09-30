import type { ProjectRoot } from '@valley/plugin-sdk/pluginExecution'
import type { ValleyPluginApi } from '../../../../api'
import { clip, type AgentTool } from './sdk'
export function projectTools(api: ValleyPluginApi, chatId: string, roots: ProjectRoot[]): AgentTool[] {
  if (!roots.length) return []
  const properties = { rootId: { type: 'string', description: `Folder handle; defaults to ${roots[0].id}.` }, path: { type: 'string', description: 'Absolute path, ~/ path, or path relative to the current working directory. External paths require Full access.' } }
  const files: AgentTool[] = (['list', 'read', 'write'] as const).map(operation => ({
    name: `project_${operation}_file`, description: operation === 'list' ? 'List files and folders within the current access scope, including external directories in Full access.' : operation === 'read' ? 'Read a text file and its baseline for conflict-safe editing, including external files in Full access.' : 'Create or edit a text file directly, preserving unsaved editor buffers and refusing changed baselines. Supply the baseline from the latest read, or null for a new file. Create missing directories with project_command first.',
    parameters: { type: 'object', properties: { ...properties, ...(operation === 'write' ? { content: { type: 'string' }, expected: { anyOf: [{ type: 'null' }, { type: 'object', properties: { hash: { type: 'string' }, size: { type: 'number' }, mtimeMs: { type: 'number' } }, required: ['hash', 'size', 'mtimeMs'], additionalProperties: false }] } } : {}) }, required: operation === 'write' ? ['path', 'content', 'expected'] : ['path'], additionalProperties: false },
    sideEffect: operation === 'write' ? 'write' : 'read',
    drainOnCancel: true,
    run: async (args, options) => {
      const output = JSON.stringify(await api.backend.callOperation('project.file', { chatId, operation, ...args, activity: options?.activity, rootId: args.rootId ?? roots[0].id }, { cancellation: options?.cancellation }), null, 2)
      return { text: clip(output, 16000), output }
    }
  }))
  return [...files, {
    name: 'project_command', description: 'Run a terminal command using installed development tools. Use for creating directories, coding, tests, and other terminal work. Vault only confines access to the vault; Full access also permits external paths. Use absolute paths from the provided user home for Desktop and other personal folders; the shell HOME is a private runtime folder. Returns stdout, stderr, duration, and exit status. Network access follows Guards.',
    parameters: { type: 'object', properties: { command: { type: 'string' }, rootId: properties.rootId, path: { type: 'string', description: 'Working directory: absolute, ~/ path, or relative to the current working directory.' }, network: { type: 'boolean' } }, required: ['command'], additionalProperties: false },
    sideEffect: 'write', timeoutMs: 300000, drainOnCancel: true,
    run: (args, options) => api.backend.callOperation('project.command', { chatId, ...args, rootId: args.rootId ?? roots[0].id, activity: options?.activity }, { cancellation: options?.cancellation })
  }]
}
