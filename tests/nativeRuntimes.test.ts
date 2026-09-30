// @vitest-environment node
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import type { PluginProcessEvent } from '@valley/plugin-sdk/pluginExecution'
import type { AiChatRequest, AiStreamEvent } from '../src/types'
import { initBackend } from '../src/backend/runtime'
import { runNativeRuntime, respondToRuntime, steerRuntime } from '../src/backend/runtimes'
import { stopChatProcesses } from '../src/backend/processScopes'
const activity = vi.hoisted(() => ({ rows: [] as unknown[], outputs: [] as string[] }))
vi.mock('../src/backend/attachments', () => ({ assertChatWritable: async () => {} }))
vi.mock('../src/backend/activity', () => ({ outputChunks: function* (value: string) { yield value }, appendActivity: async (_chat: string, value: unknown) => { activity.rows.push(value) }, activityRequest: async (_method: string, value: { text: string }) => { activity.outputs.push(value.text); return 'a'.repeat(64) } }))
let directory: string, child: ChildProcessWithoutNullStreams | undefined, closed: Promise<void>, context: PluginBackendOperationContext, controller: AbortController
let api: PluginBackendApi, requests: AiChatRequest[], messages: Array<Record<string, unknown>>, toolSeen: boolean, respond: boolean, parallel: boolean
const listeners = new Set<(event: PluginProcessEvent) => void>(), streams = new Set<(event: AiStreamEvent) => void>()
const nativeArch = process.env.ASSISTANT_RUNTIME_TEST_ARCH ?? process.arch
const harness = 'deepseek'
const input = () => ({ runId: crypto.randomUUID(), chatId: 'fixture-chat', harness, request: { requestId: crypto.randomUUID(), provider: 'fixture', connectionId: 'selected', model: 'exact-model', messages: [{ role: 'system', content: 'Use the supplied tool.' }, { role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }, { role: 'user', content: 'Read flower.txt' }], tools: [{ name: 'read_file', description: 'Read a project file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }] } })
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(tmpdir(), 'assistant-runtime-'))
  await fs.writeFile(path.join(directory, 'flower.txt'), 'Blüten ä ö ü')
  requests = []; messages = []; toolSeen = false; respond = true; parallel = false; listeners.clear(); streams.clear(); activity.rows = []; activity.outputs = []
  controller = new AbortController()
  const cancel = async () => { if (!child || child.exitCode !== null || child.signalCode) return false; child.kill('SIGTERM'); const timer = setTimeout(() => child?.kill('SIGKILL'), 1000); await closed; clearTimeout(timer); return true }
  api = {
    rpc: { emit: (name: string, value: Record<string, unknown>) => {
      if (name !== 'harness.event') return
      messages.push(value)
      if (value.type === 'tool') {
        toolSeen = true
        if (respond) void fs.readFile(path.join(directory, 'flower.txt'), 'utf8').then(text => respondToRuntime({ runId: value.runId, id: value.id, text }))
      }
    } },
    ai: {
      onStream: (listener: (event: AiStreamEvent) => void) => { streams.add(listener); return () => streams.delete(listener) }, cancel: async () => true,
      complete: async (request: AiChatRequest) => {
        requests.push(request)
        const awaiting = new Set<string>()
        for (const message of request.messages) {
          if (message.role === 'tool') {
            expect(awaiting.delete(message.toolCallId!)).toBe(true)
          } else {
            expect([...awaiting]).toEqual([])
            for (const call of message.toolCalls ?? []) awaiting.add(call.id)
          }
        }
        expect([...awaiting]).toEqual([])
        const call = { id: 'read-one', name: 'read_file', arguments: { path: 'flower.txt' } }
        const calls = requests.length === 1 ? [call, ...(parallel ? [{ ...call, id: 'read-two' }] : [])] : []
        const emit = (event: AiStreamEvent) => { for (const listener of streams) listener(event) }
        if (requests.length === 1) for (const call of calls) emit({ requestId: request.requestId, type: 'tool_call', call })
        else emit({ requestId: request.requestId, type: 'text', text: 'Verified Grüße' })
        return { text: requests.length === 1 ? '' : 'Verified Grüße', toolCalls: calls, inputTokens: 10, outputTokens: 2, latencyMs: 1, events: [], connectionId: 'selected', continuation: { provider: 'fixture', model: 'exact-model', reasoningContent: `continuation-${requests.length}` } }
      }
    },
    process: {
      available: async () => ({ available: true, platform: 'darwin', arch: nativeArch, runtimes: ['deepseek'] }),
      onEvent: (listener: (event: PluginProcessEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      start: async ({ id, args, environment }: { id: string; args: string[]; environment: Record<string, string> }) => {
        child = spawn(path.resolve(`vendor/native/node/${nativeArch}/node`), [path.resolve('vendor/native/deepseek/runtime.mjs'), ...args], { cwd: directory, env: { HOME: directory, TMPDIR: directory, PATH: '/usr/bin:/bin', ...environment }, stdio: 'pipe' })
        const emit = (event: PluginProcessEvent) => { for (const listener of listeners) listener(event) }
        for (const stream of ['stdout', 'stderr'] as const) child[stream].on('data', (bytes: Buffer) => emit({ type: 'output', id, stream, base64: bytes.toString('base64'), timestamp: Date.now() }))
        closed = new Promise(resolve => { child!.once('close', (exitCode, signal) => { emit({ type: 'exit', result: { id, exitCode, signal, durationMs: 0, cancelled: Boolean(signal) }, timestamp: Date.now() }); resolve() }) })
        await new Promise<void>((resolve, reject) => { child!.once('spawn', resolve); child!.once('error', reject) })
        return { id, cwd: directory, home: directory }
      },
      input: async (_id: string, text: string) => { await new Promise<void>((resolve, reject) => child!.stdin.write(text, error => error ? reject(error) : resolve())) },
      cancel, shutdown: cancel
    }
  } as unknown as PluginBackendApi
  initBackend(api)
  context = { id: crypto.randomUUID(), cancellation: controller.signal, api }
})
afterEach(async () => { if (child && child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await closed }; child = undefined; await fs.rm(directory, { recursive: true, force: true }) })
describe.skipIf(process.platform !== 'darwin')('bundled DeepSeek with the Assistant shared transport adapter', () => {
  it.each(['low', 'high', 'max'] as const)('retains history and the exact model at %s effort through tools', async reasoningEffort => {
    const turn = input()
    await runNativeRuntime({ ...turn, request: { ...turn.request, reasoningEffort } }, context)
    expect(requests.every(request => request.reasoningEffort === reasoningEffort)).toBe(true)
    expect(requests).toHaveLength(2)
    expect(requests[1].messages.find(message => message.toolCalls?.length)?.continuation?.reasoningContent).toBe('continuation-1')
    expect(requests.every(request => request.model === 'exact-model' && request.connectionId === 'selected' && request.origin === 'harness')).toBe(true)
    expect(requests[1].messages).toEqual(expect.arrayContaining([expect.objectContaining({ content: 'Earlier answer' }), expect.objectContaining({ role: 'tool', content: 'Blüten ä ö ü' })]))
    expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'Verified Grüße' }), expect.objectContaining({ type: 'message', message: expect.objectContaining({ role: 'assistant', content: 'Verified Grüße', ts: expect.any(Number) }) })]))
    expect(messages.filter(event => event.type === 'message' && (event.message as { role: string }).role === 'assistant').map(event => (event.message as { continuation?: { reasoningContent: string } }).continuation?.reasoningContent)).toEqual(['continuation-1', 'continuation-2'])
    expect(activity.rows.at(-1)).toMatchObject({ name: harness, state: 'completed' })
    expect(listeners.size).toBe(0)
  }, 15000)
  it('keeps parallel calls in one assistant message before their tool results', async () => {
    parallel = true
    await runNativeRuntime(input(), context)
    expect(requests).toHaveLength(2)
    expect(requests[1].messages.find(message => message.toolCalls?.length)?.toolCalls).toHaveLength(2)
    expect(requests[1].messages.filter(message => message.role === 'tool')).toHaveLength(2)
  }, 15000)
  it('steers at the next model boundary after retaining the running tool result', async () => {
    respond = false
    const request = input()
    const running = runNativeRuntime(request, context)
    await vi.waitFor(() => expect(toolSeen).toBe(true), { timeout: 10000 })
    steerRuntime({ runId: request.runId })
    expect(requests).toHaveLength(1)
    const tool = messages.find(event => event.type === 'tool')!
    respondToRuntime({ runId: request.runId, id: tool.id, text: 'Completed moss inventory' })
    await running
    expect(requests).toHaveLength(1)
    expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'message', message: expect.objectContaining({ role: 'tool', content: 'Completed moss inventory' }) })]))
    expect(listeners.size).toBe(0)
  }, 15000)
  it('drains a pending tool and native process when its conversation is stopped', async () => {
    respond = false
    const running = runNativeRuntime(input(), context)
    const outcome = expect(running).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(toolSeen).toBe(true), { timeout: 10000 })
    await stopChatProcesses('fixture-chat')
    await outcome
    expect(child?.signalCode || child?.exitCode !== null).toBeTruthy()
    expect(listeners.size).toBe(0)
  }, 15000)
  it('starts a fresh runtime after reopening while retaining conversation history', async () => {
    const first = input()
    await runNativeRuntime(first, context)
    const history = messages.filter(event => event.type === 'message').map(event => event.message)
    const next = input()
    await runNativeRuntime({ ...next, request: { ...next.request, messages: [...first.request.messages, ...history, { role: 'user', content: 'Continue the reopened conversation' }] } }, context)
    expect(requests.at(-1)?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ content: 'Verified Grüße' }), expect.objectContaining({ content: 'Continue the reopened conversation' })]))
    expect(activity.rows.at(-1)).toMatchObject({ name: harness, state: 'completed' })
    expect(listeners.size).toBe(0)
  }, 20000)
  it('reports a runtime crash without leaving pending tool replies or event subscriptions', async () => {
    respond = false
    const running = runNativeRuntime(input(), context)
    const outcome = expect(running).rejects.toThrow('Runtime exited')
    await vi.waitFor(() => expect(toolSeen).toBe(true), { timeout: 10000 })
    child!.kill('SIGKILL')
    await outcome
    expect(activity.rows.at(-1)).toMatchObject({ state: 'failed' })
    expect(listeners.size).toBe(0)
    respond = true
    await runNativeRuntime(input(), context)
    expect(activity.rows.at(-1)).toMatchObject({ state: 'completed' })
  }, 15000)
  it('preserves the provider failure and can retry after the connection recovers', async () => {
    vi.spyOn(api.ai, 'complete').mockRejectedValueOnce(new Error('Fixture provider rejected incomplete tool history'))
    await expect(runNativeRuntime(input(), context)).rejects.toThrow('Fixture provider rejected incomplete tool history')
    expect(activity.rows.at(-1)).toMatchObject({ state: 'failed' })
    expect(listeners.size).toBe(0)
    await runNativeRuntime(input(), context)
    expect(activity.rows.at(-1)).toMatchObject({ state: 'completed' })
  }, 15000)
  it('repairs interrupted saved tool history in the request without changing stored messages or claiming success', async () => {
    const turn = input()
    const interrupted = { role: 'assistant', content: '', toolCalls: [
      { id: 'done', name: 'read_file', arguments: { path: 'flower.txt' } },
      { id: 'interrupted', name: 'read_file', arguments: { path: 'flower.txt' } }
    ], continuation: { provider: 'fixture', model: 'exact-model', reasoningContent: 'saved-continuation' } }
    const history = [turn.request.messages[0], turn.request.messages[1], interrupted,
      { role: 'tool', toolCallId: 'done', name: 'read_file', content: 'Completed read' },
      { role: 'user', content: 'Continue after interruption' }]
    const before = JSON.stringify(history)
    await runNativeRuntime({ ...turn, request: { ...turn.request, messages: history } }, context)
    expect(requests[0].messages.filter(message => message.toolCallId === 'done')).toHaveLength(1)
    expect(requests[0].messages.find(message => message.toolCallId === 'interrupted')).toMatchObject({ role: 'tool', content: expect.stringContaining('outcome is unknown') })
    expect(requests[0].messages.find(message => message.toolCalls?.some(call => call.id === 'interrupted'))?.continuation).toEqual(interrupted.continuation)
    expect(JSON.stringify(history)).toBe(before)
    expect(activity.rows.at(-1)).toMatchObject({ state: 'completed' })
  }, 15000)
})


it('reports an unavailable native runtime before starting a process', async () => {
  api.process.available = async () => ({ available: false, platform: 'linux', arch: 'x64', runtimes: [] })
  const start = vi.spyOn(api.process, 'start')
  await expect(runNativeRuntime(input(), context)).rejects.toThrow('native harness is unavailable')
  expect(start).not.toHaveBeenCalled()
})

it.skipIf(process.platform !== 'darwin')('uses supplied Valley project tools to read, create code and run a test command', async () => {
  respond = false
  const actions = [
    { id: 'read', name: 'project_read_file', arguments: { path: 'flower.txt' } },
    { id: 'write', name: 'project_write_file', arguments: { path: 'fern.cjs', content: "process.stdout.write('Fern verified')" } },
    { id: 'test', name: 'project_command', arguments: { command: 'node fern.cjs' } }
  ]
  const pending: Promise<void>[] = []
  const emit = api.rpc.emit
  api.rpc.emit = (name, payload) => {
    emit(name, payload)
    const event = payload as { type: string; call: { name: string }; id: string; runId: string }
    if (name !== 'harness.event' || event.type !== 'tool') return
    pending.push((async () => {
      const output = event.call.name === 'project_read_file' ? await fs.readFile(path.join(directory, 'flower.txt'), 'utf8')
        : event.call.name === 'project_write_file' ? (await fs.writeFile(path.join(directory, 'fern.cjs'), actions[1].arguments.content!), 'Created fern.cjs')
        : (await promisify(execFile)(process.execPath, ['fern.cjs'], { cwd: directory })).stdout
      respondToRuntime({ runId: event.runId, id: event.id, text: output })
    })().catch(error => { respondToRuntime({ runId: event.runId, id: event.id, text: `Error: ${error}` }); throw error }))
  }
  let step = 0
  api.ai.complete = async request => {
    requests.push(request)
    const action = actions[step++]
    for (const listener of streams) listener(action ? { type: 'tool_call', requestId: request.requestId, call: action } : { type: 'text', requestId: request.requestId, text: 'Code tested' })
    return { connectionId: 'selected', text: action ? '' : 'Code tested', toolCalls: action ? [action] : [], inputTokens: 1, outputTokens: 1, latencyMs: 1, events: [] }
  }
  const turn = input()
  await runNativeRuntime({ ...turn, request: { ...turn.request, tools: actions.map(action => ({ name: action.name, description: action.name, parameters: { type: 'object' } })) } }, context)
  await Promise.all(pending)
  expect(await fs.readFile(path.join(directory, 'fern.cjs'), 'utf8')).toBe(actions[1].arguments.content)
  expect(requests.at(-1)?.messages.filter(message => message.role === 'tool').map(message => message.content)).toEqual(['Blüten ä ö ü', 'Created fern.cjs', 'Fern verified'])
}, 15000)
