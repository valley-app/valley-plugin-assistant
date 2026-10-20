import type { PluginBackendOperationContext } from '@valley/plugin-sdk'
import { assertCommandOutput } from '../commandContracts'
import { describe, expect, it, vi } from 'vitest'
import { SessionCoordinator, type CoordinatorPorts } from '../../src/backend/engine/coordinator'
import { AssistantRepository } from '../../src/backend/persistence/repositories'
import { datasetFixture } from '../backendDatasetFixture'
import type { TurnSubmission } from '../../src/contracts/execution'

const submission = (conversationId: string, id = crypto.randomUUID()): TurnSubmission => ({ id, conversationId, text: 'Inspect moss', thread: { id: conversationId, title: 'Moss', createdAt: 1, updatedAt: 1, messages: [] } })
const until = async (test: () => boolean) => vi.waitFor(() => expect(test()).toBe(true))
// Holds the first durable write of one session event type until released, like storage that stops answering.
const stallSave = (data: ReturnType<typeof datasetFixture>, type: string) => {
  let release!: () => void, hit = false
  const opened = new Promise<void>(resolve => { release = resolve })
  const original = data.transaction.bind(data)
  vi.spyOn(data, 'transaction').mockImplementation(async operations => {
    if (!hit && operations.some(operation => operation.dataset === 'session_events' && !Array.isArray(operation.values) && operation.values?.state === type)) { hit = true; await opened }
    return original(operations)
  })
  return { release, hit: () => hit }
}
const durable = async (data: ReturnType<typeof datasetFixture>, id: string) => ((await data.dataset('sessions').get({ id })) as { payload: { state: string; paused: boolean; error: string | null } } | null)?.payload

describe('durable session coordinator', () => {
  it('retains cancelled admission identity after restart and does not resume an unadmitted turn', async () => {
    const data = datasetFixture(), repository = new AssistantRepository(data), run = vi.fn<CoordinatorPorts['run']>(async () => {})
    const ports = { publish: vi.fn(), project: async () => {}, run }
    const first = new SessionCoordinator(repository, ports)
    const input = { ...submission('pending-admission'), admissionPending: true }
    await first.enqueue(input)
    expect(run).not.toHaveBeenCalled()
    await first.close()
    const restored = new SessionCoordinator(repository, ports)
    try {
      await restored.restore()
      expect(restored.snapshot(input.conversationId)).toMatchObject({ state: 'FAILED', queue: [], paused: true })
      expect((await data.dataset('turn_queue').get({ id: input.id }))?.state).toBe('REMOVED')
      await restored.enqueue(input)
      expect(run).not.toHaveBeenCalled()
    } finally { await restored.close() }
  })
  it('holds recovered admitted queue entries for review instead of draining them after a fresh message', async () => {
    const repository = new AssistantRepository(datasetFixture()), run = vi.fn<CoordinatorPorts['run']>(async () => {})
    const ports = { publish: vi.fn(), project: async () => {}, run }
    const first = new SessionCoordinator(repository, ports), input = { ...submission('held-admission'), admissionPending: true }
    await first.enqueue(input); await first.stop(input.conversationId)
    await first.acceptAdmission(input.conversationId, input.id, { check: () => {}, step: (_stage, work) => work() })
    await first.close()
    const restored = new SessionCoordinator(repository, ports)
    try {
      await restored.restore()
      expect(restored.snapshot(input.conversationId)?.queue[0]).toMatchObject({ id: input.id, editing: true, admissionPending: false })
      const fresh = submission(input.conversationId)
      await restored.enqueue(fresh); await restored.steer(input.conversationId, fresh.id)
      await restored.waitForTurn(input.conversationId, fresh.id)
      expect(run).toHaveBeenCalledOnce()
      expect(run.mock.calls[0][1]?.id).toBe(fresh.id)
      expect(restored.snapshot(input.conversationId)?.queue[0]?.id).toBe(input.id)
    } finally { await restored.close() }
  })
  it('streams separate conversations simultaneously and stops only the selected conversation', async () => {
    const controlsByChat = new Map<string, Parameters<CoordinatorPorts['run']>[2]>()
    let finishFern!: () => void
    const coordinator = new SessionCoordinator(new AssistantRepository(datasetFixture()), { publish: vi.fn(), project: async () => {}, run: async (session, _turn, controls) => {
      controlsByChat.set(session.conversationId, controls)
      await controls.state('INFERRING')
      await controls.stream(session.conversationId)
      if (session.conversationId === 'moss') await new Promise<void>(resolve => controls.signal.addEventListener('abort', () => resolve(), { once: true }))
      else await new Promise<void>(resolve => { finishFern = resolve })
    } })
    await coordinator.enqueue(submission('moss'))
    await coordinator.enqueue(submission('fern'))
    await until(() => Boolean(finishFern) && coordinator.snapshot('moss')?.state === 'INFERRING')
    assertCommandOutput('command.session.snapshot', {}, coordinator.snapshot('moss'))
    assertCommandOutput('command.session.submit', {}, coordinator.snapshot('fern'))
    expect(coordinator.snapshot('moss')?.streamingText).toBe('moss')
    expect(coordinator.snapshot('fern')?.streamingText).toBe('fern')
    await coordinator.stop('moss')
    await until(() => coordinator.snapshot('moss')?.state === 'INTERRUPTED')
    expect(controlsByChat.get('fern')!.signal.aborted).toBe(false)
    await controlsByChat.get('fern')!.stream('Fern is still writing')
    expect(coordinator.snapshot('fern')?.streamingText).toBe('Fern is still writing')
    finishFern()
    await until(() => coordinator.snapshot('fern')?.state === 'IDLE')
    await coordinator.close()
  })

  it('accepts fresh steering while a failed run is still saving its final projection', async () => {
    let release!: () => void
    const saved = new Promise<void>(resolve => { release = resolve })
    const run = vi.fn<CoordinatorPorts['run']>(async () => {})
    run.mockRejectedValueOnce(new Error('Provider unavailable'))
    const project = vi.fn<CoordinatorPorts['project']>(async () => {})
    project.mockImplementationOnce(async () => saved)
    const coordinator = new SessionCoordinator(new AssistantRepository(datasetFixture()), { publish: vi.fn(), project, run })
    try {
      await coordinator.enqueue(submission('moss'))
      await until(() => project.mock.calls.length === 1)
      const fresh = submission('moss')
      await coordinator.enqueue(fresh)
      await coordinator.steer('moss', fresh.id)
      expect(coordinator.snapshot('moss')).toMatchObject({ state: 'QUEUED', paused: false, error: null })
      expect(coordinator.snapshot('moss')?.currentTurn).toBeUndefined()
      expect(run).toHaveBeenCalledOnce()
      release()
      await until(() => coordinator.snapshot('moss')?.state === 'IDLE')
      expect(run).toHaveBeenCalledTimes(2)
      expect(run.mock.calls[1][1]?.id).toBe(fresh.id)
    } finally { release(); await coordinator.close() }
  })

  it('releases capacity for a question and reacquires it before continuing', async () => {
    let answer!: () => void, finishOther!: () => void
    const events: string[] = []
    const coordinator = new SessionCoordinator(new AssistantRepository(datasetFixture()), { publish: vi.fn(), project: async () => {}, run: async (session, _turn, controls) => {
      await controls.state('INFERRING')
      if (session.conversationId === 'question') {
        await controls.state('AWAITING_QUESTION')
        await new Promise<void>(resolve => { answer = resolve })
        await controls.state('INFERRING')
        events.push('answered')
      } else { events.push('other'); await new Promise<void>(resolve => { finishOther = resolve }) }
    } }, 1)
    await coordinator.enqueue(submission('question'))
    await until(() => Boolean(answer))
    await coordinator.enqueue(submission('other'))
    await until(() => Boolean(finishOther))
    answer(); await new Promise(resolve => setTimeout(resolve, 10))
    expect(events).toEqual(['other'])
    finishOther(); await until(() => events.includes('answered'))
    await coordinator.close()
  })
  it('bounds parallel conversations and serializes each conversation', async () => {
    const releases: Array<() => void> = [], active = new Set<string>()
    const ports: CoordinatorPorts = { publish: vi.fn(), project: async () => {}, run: async (session, _turn, controls) => {
      expect(active.has(session.conversationId)).toBe(false)
      active.add(session.conversationId)
      await controls.state('INFERRING')
      await new Promise<void>(resolve => releases.push(resolve))
      active.delete(session.conversationId)
    } }
    const coordinator = new SessionCoordinator(new AssistantRepository(datasetFixture()), ports, 2)
    await coordinator.enqueue(submission('moss')); await coordinator.enqueue(submission('moss')); await coordinator.enqueue(submission('fern')); await coordinator.enqueue(submission('oak'))
    await until(() => releases.length === 2)
    expect(active.size).toBe(2)
    releases.shift()!(); await until(() => releases.length === 2)
    releases.shift()!(); releases.shift()!(); await until(() => releases.length === 1)
    releases.shift()!(); await until(() => active.size === 0)
    await coordinator.close()
  })
  it('deduplicates submissions durably and restores interruption without replay', async () => {
    const repository = new AssistantRepository(datasetFixture())
    const ports: CoordinatorPorts = { publish: vi.fn(), project: async () => {}, run: async (_session, _turn, controls) => {
      await controls.state('INFERRING')
      await controls.message({ id: 'reply', role: 'assistant', content: 'Moss identified' })
      await new Promise<void>(resolve => controls.signal.addEventListener('abort', () => resolve(), { once: true }))
    } }
    const coordinator = new SessionCoordinator(repository, ports)
    const input = submission('moss')
    await coordinator.enqueue(input); await coordinator.enqueue(input)
    await until(() => coordinator.snapshot('moss')?.state === 'INFERRING')
    await coordinator.enqueue(submission('moss'))
    await coordinator.close()
    const run = vi.fn(async () => {})
    const restored = new SessionCoordinator(repository, { ...ports, run })
    await restored.restore()
    expect(run).not.toHaveBeenCalled()
    expect(restored.snapshot('moss')).toMatchObject({ state: 'INTERRUPTED', paused: true, queue: [{ text: 'Inspect moss' }] })
    expect(restored.snapshot('moss')!.thread!.messages.filter(message => message.id === 'reply')).toHaveLength(1)
    await restored.close()
  })
  it('does not dispatch a turn when its transaction fails', async () => {
    const data = datasetFixture(), run = vi.fn(async () => {})
    vi.spyOn(data, 'transaction').mockRejectedValueOnce(new Error('Storage unavailable'))
    const coordinator = new SessionCoordinator(new AssistantRepository(data), { publish: vi.fn(), project: async () => {}, run })
    await expect(coordinator.enqueue(submission('moss'))).rejects.toThrow('Storage unavailable')
    expect(run).not.toHaveBeenCalled()
    expect(coordinator.snapshot('moss')).toBeNull()
    await coordinator.close()
  })
  it('restores sessions in small pages', async () => {
    const data = datasetFixture()
    const first = new SessionCoordinator(new AssistantRepository(data), { publish: vi.fn(), project: async () => {}, run: async () => {} })
    for (let index = 0; index < 45; index++) { const input = submission(`moss-${index}`); await first.enqueue(input); await first.waitForTurn(input.conversationId, input.id) }
    await first.close()
    const limits: Array<number | undefined> = []
    const counted = { ...data, dataset: ((name: string) => { const dataset = data.dataset(name); return name === 'sessions' ? { ...dataset, query: (options?: Parameters<typeof dataset.query>[0]) => { limits.push(options?.limit); return dataset.query(options) } } : dataset }) as typeof data.dataset }
    const restored = new SessionCoordinator(new AssistantRepository(counted), { publish: vi.fn(), project: async () => {}, run: async () => {} })
    await restored.restore()
    expect(limits).toEqual([20, 20, 20])
    expect(restored.snapshot('moss-44')).toMatchObject({ state: 'IDLE' })
    await restored.close()
  })
  it('restores settled conversations without their messages and reads them back before any use or write', async () => {
    const data = datasetFixture()
    const ports = { publish: vi.fn(), project: vi.fn<CoordinatorPorts['project']>(async () => {}), run: async (_session: unknown, _turn: unknown, controls: { message(message: { role: 'assistant'; content: string }): Promise<void> }) => { await controls.message({ role: 'assistant', content: 'Moss reply' }) } }
    const first = new SessionCoordinator(new AssistantRepository(data), ports)
    for (const id of ['moss', 'lichen', 'fern', 'reed']) { const input = submission(id); await first.enqueue(input); await first.waitForTurn(id, input.id) }
    await first.close()
    ports.project.mockClear()
    const restored = new SessionCoordinator(new AssistantRepository(data), ports)
    await restored.restore()
    expect(ports.project).toHaveBeenCalledTimes(4)
    expect(restored.snapshot('moss')).toMatchObject({ state: 'IDLE' })
    expect(restored.snapshot('moss')?.thread).toBeUndefined()
    expect((await restored.load('moss'))?.thread?.messages).toMatchObject([{ content: 'Moss reply' }])
    await restored.stop('lichen')
    expect(((await data.dataset('sessions').get({ id: 'lichen' }))?.payload as { thread?: { messages: unknown[] } }).thread?.messages).toHaveLength(1)
    await restored.change('fern', async thread => { thread.title = 'Fern'; return {} })
    expect(restored.snapshot('fern')?.thread).toMatchObject({ title: 'Fern', messages: [{ content: 'Moss reply' }] })
    const next = submission('reed')
    await restored.enqueue(next)
    expect((await restored.waitForTurn('reed', next.id)).thread?.messages).toHaveLength(2)
    await restored.close()
  })
  it('rolls a failed change back to the stored session', async () => {
    const data = datasetFixture()
    const coordinator = new SessionCoordinator(new AssistantRepository(data), { publish: vi.fn(), project: async () => {}, run: async (_session, _turn, controls) => { await controls.message({ role: 'assistant', content: 'Moss reply' }) } })
    const input = submission('moss')
    await coordinator.enqueue(input)
    await coordinator.waitForTurn(input.conversationId, input.id)
    vi.spyOn(data, 'transaction').mockRejectedValueOnce(new Error('Storage unavailable'))
    await expect(coordinator.change('moss', async thread => { thread.title = 'Lichen'; return {} })).rejects.toThrow('Storage unavailable')
    expect(coordinator.snapshot('moss')).toMatchObject({ state: 'IDLE', thread: { title: 'Moss', messages: [{ content: 'Moss reply' }] } })
    expect(coordinator.snapshot('moss')).toEqual((await durable(data, 'moss')) && (await data.dataset('sessions').get({ id: 'moss' }))!.payload)
    await coordinator.close()
  })
  it('keeps each submitted owner until its final projection and reports committed completion after a late cancel', async () => {
    const data = datasetFixture(), background = datasetFixture()
    const backgroundWrite = vi.spyOn(background, 'transaction')
    const owner = { data } as PluginBackendOperationContext['api']
    let finish!: () => void, publish!: () => void
    const coordinator = new SessionCoordinator(new AssistantRepository(background), { publish: vi.fn(), run: async (_session, _turn, controls) => {
      expect(controls.api).toBe(owner)
      await new Promise<void>(resolve => { finish = resolve })
      await controls.message({ role: 'assistant', content: 'Committed reply' })
    }, project: async (_session, _restore, api) => { expect(api).toBe(owner); await new Promise<void>(resolve => { publish = resolve }) } })
    const input = submission('owned'), controller = new AbortController()
    await coordinator.enqueue(input, [], owner)
    let completed = false
    const result = coordinator.waitForTurn(input.conversationId, input.id, controller.signal).then(value => { completed = true; return value })
    await until(() => Boolean(finish)); expect(completed).toBe(false)
    finish(); await until(() => Boolean(publish)); expect(completed).toBe(false)
    publish(); expect((await result).thread?.messages[0].content).toBe('Committed reply')
    controller.abort()
    expect((await coordinator.waitForTurn(input.conversationId, input.id, controller.signal)).state).toBe('IDLE')
    expect(backgroundWrite).not.toHaveBeenCalled()
    await coordinator.close()
  })

  it('rejects revoked late commits without ambient fallback while another operation completes', async () => {
    const data = datasetFixture(), background = datasetFixture()
    const backgroundWrite = vi.spyOn(background, 'transaction')
    let revoked = false, release!: () => void
    const scopedWrite = vi.fn<typeof data.transaction>(async operations => { if (revoked) throw new Error('Operation revoked'); return data.transaction(operations) })
    const owner = { data: { ...data, transaction: scopedWrite } } as unknown as PluginBackendOperationContext['api']
    const other = { data } as PluginBackendOperationContext['api']
    const coordinator = new SessionCoordinator(new AssistantRepository(background), { publish: vi.fn(), project: async () => {}, run: async (session, _turn, controls) => {
      if (session.conversationId === 'revoked') {
        expect(controls.api).toBe(owner)
        await new Promise<void>(resolve => { release = resolve })
        await controls.message({ role: 'assistant', content: 'Forbidden late message' })
      } else { expect(controls.api).toBe(other); await controls.message({ role: 'assistant', content: 'Independent reply' }) }
    } })
    const first = submission('revoked'), second = submission('allowed')
    await coordinator.enqueue(first, [], owner)
    await until(() => Boolean(release)); revoked = true
    const failed = coordinator.waitForTurn(first.conversationId, first.id)
    await coordinator.enqueue(second, [], other)
    expect((await coordinator.waitForTurn(second.conversationId, second.id)).thread?.messages[0].content).toBe('Independent reply')
    release(); await expect(failed).rejects.toThrow('Operation revoked')
    expect(coordinator.snapshot(first.conversationId)?.thread?.messages).toEqual([])
    expect(backgroundWrite).not.toHaveBeenCalled()
    await coordinator.close()
  })

  it('joins a cancelled run before rejecting, records it interrupted and never commits its late message', async () => {
    const controller = new AbortController(), data = datasetFixture(), background = datasetFixture()
    const fallback = vi.spyOn(background, 'transaction')
    const owner = { data: { ...data, transaction: async (...args: Parameters<typeof data.transaction>) => { controller.signal.throwIfAborted(); return data.transaction(...args) } } } as unknown as PluginBackendOperationContext['api']
    let started = false, joined = false
    const coordinator = new SessionCoordinator(new AssistantRepository(background), { publish: vi.fn(), project: async () => { joined = true }, run: async (_session, _turn, controls) => {
      started = true
      await new Promise<void>(resolve => controls.signal.addEventListener('abort', () => resolve(), { once: true }))
      await controls.message({ role: 'assistant', content: 'Rejected after cancellation' })
    } })
    const input = submission('cancelled')
    await coordinator.enqueue(input, [], owner)
    const result = coordinator.waitForTurn(input.conversationId, input.id, controller.signal)
    await until(() => started); controller.abort(new Error('Caller cancelled'))
    await expect(result).rejects.toThrow('Caller cancelled')
    expect(joined).toBe(true)
    expect(coordinator.snapshot(input.conversationId)?.thread?.messages).toEqual([])
    // The caller's operation is closed, so only the background repository can record the interruption; otherwise the chat stays PREPARING with a current turn nothing runs.
    expect(coordinator.snapshot(input.conversationId)).toMatchObject({ state: 'INTERRUPTED', error: null })
    expect(await durable(background, input.conversationId)).toMatchObject({ state: 'INTERRUPTED' })
    expect(JSON.stringify(fallback.mock.calls)).not.toContain('Rejected after cancellation')
    await coordinator.close()
  })

  it.each([
    { name: 'reports a cancelled turn that ran no tool as not applied', tool: false, rewrite: false },
    { name: 'reports a cancelled turn as not applied after it rewrote its own user message', tool: false, rewrite: true },
    { name: 'keeps a cancelled turn that reached a tool without a not-applied claim', tool: true, rewrite: false },
    { name: 'reports a cancelled turn that only read the command catalog as not applied', tool: false, rewrite: false, calls: ['command_list', 'command_describe'] },
    { name: 'keeps a cancelled turn that executed a command after catalog discovery without a not-applied claim', tool: true, rewrite: false, calls: ['command_describe', 'command_execute'] }
  ])('$name', async ({ tool, rewrite, calls }) => {
    const controller = new AbortController()
    let streaming = false
    const coordinator = new SessionCoordinator(new AssistantRepository(datasetFixture()), { publish: vi.fn(), project: async () => {}, run: async (_session, turn, controls) => {
      await controls.message({ id: turn!.id, role: 'user', content: turn!.text })
      if (rewrite) await controls.update(thread => { thread.messages[0] = { ...thread.messages[0], content: `${turn!.text}\n` } })
      await controls.state('INFERRING')
      await controls.stream('1. A quiet stream')
      for (const name of calls ?? []) {
        await controls.message({ role: 'assistant', content: '', toolCalls: [{ id: `${name}-call`, name, arguments: {} }] })
        await controls.state('AWAITING_TOOLS', name)
        await controls.state('EXECUTING_TOOLS', name)
        await controls.message({ role: 'tool', content: '{}', toolCallId: `${name}-call`, name })
        await controls.state('INFERRING')
      }
      if (tool && !calls) await controls.state('AWAITING_TOOLS')
      streaming = true
      await new Promise<void>((_resolve, reject) => controls.signal.addEventListener('abort', () => reject(new Error('Execution interrupted')), { once: true }))
    } })
    const input = submission(tool ? 'cancel-after-tool' : 'cancel-after-text')
    await coordinator.enqueue(input)
    const result = coordinator.waitForTurn(input.conversationId, input.id, controller.signal)
    await until(() => streaming); controller.abort(new Error('Aborted'))
    const error = await result.then(() => undefined, value => value)
    expect(error).toMatchObject({ message: 'Aborted' })
    if (tool) expect(error).not.toHaveProperty('outcome')
    else expect(error).toMatchObject({ name: 'AbortError', committed: false, outcome: 'not-applied', retryable: false })
    expect(coordinator.snapshot(input.conversationId)?.state).toBe('INTERRUPTED')
    expect(coordinator.snapshot(input.conversationId)?.thread?.messages.find(message => message.role === 'user')).toMatchObject({ id: input.id, stopped: true })
    await coordinator.close()
  })

  it('resumes a stopped turn and steers a running one to known completed snapshots instead of interrupted failures', async () => {
    let calls = 0, settle: (() => void) | undefined
    const coordinator = new SessionCoordinator(new AssistantRepository(datasetFixture()), { publish: vi.fn(), project: async (session) => { if (session.state === 'INTERRUPTED' || session.state === 'QUEUED') await new Promise<void>(resolve => { settle = resolve }) }, run: async (_session, turn, controls) => {
      const call = ++calls
      if (call === 1 || call === 3) await new Promise<void>((_resolve, reject) => controls.signal.addEventListener('abort', () => reject(new Error('Execution interrupted')), { once: true }))
      await controls.message({ role: 'assistant', content: `Reply ${call} ${turn?.text ?? 'continued'}` })
    } })
    const stopped = submission('stopped')
    await coordinator.enqueue(stopped)
    await until(() => calls === 1)
    await coordinator.stop('stopped')
    await until(() => coordinator.snapshot('stopped')?.state === 'INTERRUPTED' && Boolean(settle))
    const resumed = coordinator.resume('stopped').then(() => coordinator.waitForTurn('stopped'))
    settle!(); settle = undefined
    expect(await resumed).toMatchObject({ state: 'IDLE', thread: { messages: [{ role: 'assistant', content: 'Reply 2 continued' }] } })
    const first = submission('steered'), second = { ...submission('steered'), text: 'Steer moss' }
    await coordinator.enqueue(first)
    await until(() => calls === 3)
    await coordinator.enqueue(second)
    const steered = coordinator.steer('steered', second.id).then(() => coordinator.waitForTurn('steered', second.id))
    await until(() => Boolean(settle)); settle!()
    expect(await steered).toMatchObject({ state: 'IDLE', thread: { messages: [{ role: 'assistant', content: 'Reply 4 Steer moss' }] } })
    await coordinator.close()
  })

  describe('stop, failure and queue recovery (4.8)', () => {
    it('a stalled start save never holds the chat, sends nothing, and Continue runs the turn once', async () => {
      const data = datasetFixture(), run = vi.fn<CoordinatorPorts['run']>(async () => {}), publish = vi.fn()
      const stalled = stallSave(data, 'started')
      const coordinator = new SessionCoordinator(new AssistantRepository(data), { publish, project: async () => {}, run }, 4, 50)
      const input = submission('stalled-start')
      try {
        await coordinator.enqueue(input)
        await expect(coordinator.waitForTurn(input.conversationId, input.id)).rejects.toThrow('nothing was sent')
        expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'FAILED', paused: true, error: expect.stringContaining('Press Continue') })
        expect(run).not.toHaveBeenCalled()
        stalled.release()
        await vi.waitFor(async () => expect(await durable(data, input.conversationId)).toMatchObject({ state: 'FAILED', paused: true }))
        expect(run).not.toHaveBeenCalled()
        await coordinator.resume(input.conversationId)
        await vi.waitFor(() => expect(coordinator.snapshot(input.conversationId)).toMatchObject({ state: 'IDLE', paused: false }))
        expect(run).toHaveBeenCalledOnce()
      } finally { await coordinator.close() }
    })
    it('a stalled final save keeps the reply, frees the chat, and the late save stands as done', async () => {
      const data = datasetFixture(), publish = vi.fn()
      const stalled = stallSave(data, 'finished')
      const coordinator = new SessionCoordinator(new AssistantRepository(data), { publish, project: async () => {}, run: async (_session, _turn, controls) => {
        await controls.state('INFERRING')
        await controls.message({ id: 'reply', role: 'assistant', content: 'Moss identified' })
      } }, 4, 50)
      const input = submission('stalled-finish')
      try {
        await coordinator.enqueue(input)
        await expect(coordinator.waitForTurn(input.conversationId, input.id)).rejects.toThrow('saving it is taking too long')
        expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'FAILED', paused: true, thread: { messages: [{ id: 'reply' }] } })
        stalled.release()
        await vi.waitFor(async () => expect(await durable(data, input.conversationId)).toMatchObject({ state: 'IDLE', paused: false, error: null }))
        expect(coordinator.snapshot(input.conversationId)).toMatchObject({ state: 'IDLE', paused: false, thread: { messages: [{ id: 'reply', content: 'Moss identified' }] } })
      } finally { await coordinator.close() }
    })
    it('Stop answers within the bound while a save is stalled, and the next message runs exactly once', async () => {
      const data = datasetFixture(), publish = vi.fn(), calls: string[] = []
      const coordinator = new SessionCoordinator(new AssistantRepository(data), { publish, project: async () => {}, run: async (session, turn, controls) => {
        calls.push((turn ?? session.currentTurn)!.text)
        await controls.state('INFERRING')
        if (calls.length === 1) await controls.stream('Looking at the moss')
        controls.signal.throwIfAborted()
        await controls.message({ role: 'assistant', content: `Reply to ${(turn ?? session.currentTurn)!.text}` })
      } }, 4, 50)
      const input = submission('stalled-stop')
      const stalled = stallSave(data, 'stream')
      try {
        await coordinator.enqueue(input)
        await until(stalled.hit)
        const started = performance.now()
        await coordinator.stop(input.conversationId)
        expect(performance.now() - started).toBeLessThan(1000)
        expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ state: 'INTERRUPTED', paused: true, error: null })
        stalled.release()
        await vi.waitFor(async () => expect(await durable(data, input.conversationId)).toMatchObject({ state: 'INTERRUPTED', paused: true }))
        const next = { ...submission(input.conversationId), text: 'Count the spores' }
        await coordinator.enqueue(next); await coordinator.steer(input.conversationId, next.id)
        await coordinator.waitForTurn(input.conversationId, next.id)
        expect(calls).toEqual(['Inspect moss', 'Count the spores'])
        expect(coordinator.snapshot(input.conversationId)?.thread?.messages.map(message => [message.content, message.error ?? false])).toEqual([['Looking at the moss', true], ['Reply to Count the spores', false]])
      } finally { await coordinator.close() }
    })
    it('Stop before admission dispatches nothing, and the next message after a provider failure runs exactly once', async () => {
      const data = datasetFixture(), calls: string[] = []
      const coordinator = new SessionCoordinator(new AssistantRepository(data), { publish: vi.fn(), project: async () => {}, run: async (session, turn) => {
        const text = (turn ?? session.currentTurn)!.text
        calls.push(text)
        if (text === 'Inspect moss') throw new Error('Provider returned HTTP 500')
      } }, 4, 50)
      const pending = { ...submission('stop-admission'), admissionPending: true }
      try {
        await coordinator.enqueue(pending)
        await coordinator.stop(pending.conversationId)
        await coordinator.acceptAdmission(pending.conversationId, pending.id, { check: () => {}, step: (_stage, work) => work() })
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(calls).toEqual([])
        await coordinator.resume(pending.conversationId)
        await expect(coordinator.waitForTurn(pending.conversationId, pending.id)).rejects.toThrow('HTTP 500')
        const next = { ...submission(pending.conversationId), text: 'Count the spores' }
        await coordinator.enqueue(next); await coordinator.steer(pending.conversationId, next.id)
        await coordinator.waitForTurn(pending.conversationId, next.id)
        expect(calls).toEqual(['Inspect moss', 'Count the spores'])
      } finally { await coordinator.close() }
    })
    it('a restored queue holds earlier and expired answers instead of replaying them', async () => {
      const repository = new AssistantRepository(datasetFixture())
      const first = new SessionCoordinator(repository, { publish: vi.fn(), project: async () => {}, run: async (_session, _turn, controls) => {
        await controls.state('INFERRING')
        await new Promise<void>(resolve => controls.signal.addEventListener('abort', () => resolve(), { once: true }))
      } })
      const input = submission('restore-held'), answer = { ...submission('restore-held'), text: 'Option A', questionId: 'expired-question' }
      await first.enqueue(input)
      await until(() => first.snapshot(input.conversationId)?.state === 'INFERRING')
      await first.enqueue(answer)
      await first.close()
      const run = vi.fn<CoordinatorPorts['run']>(async () => {})
      const restored = new SessionCoordinator(repository, { publish: vi.fn(), project: async () => {}, run })
      try {
        await restored.restore()
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(run).not.toHaveBeenCalled()
        expect(restored.snapshot(input.conversationId)).toMatchObject({ state: 'INTERRUPTED', paused: true })
      } finally { await restored.close() }
    })
  })

  describe('terminal-waiting callers (4.10)', () => {
    it("withdraws a cancelled caller's queued turn at once, so it never runs later", async () => {
      const data = datasetFixture(), calls: string[] = []
      let release: (() => void) | undefined
      const coordinator = new SessionCoordinator(new AssistantRepository(data), { publish: vi.fn(), project: async () => {}, run: async (session, turn) => {
        const text = (turn ?? session.currentTurn)!.text
        calls.push(text)
        if (text === 'First') await new Promise<void>(resolve => { release = resolve })
      } })
      const first = { ...submission('withdraw'), text: 'First' }, second = { ...submission('withdraw'), text: 'Second' }
      try {
        await coordinator.enqueue(first); await until(() => Boolean(release))
        await coordinator.enqueue(second)
        const controller = new AbortController()
        const waiting = coordinator.waitForTurn('withdraw', second.id, controller.signal)
        controller.abort(new Error('Caller cancelled'))
        await expect(waiting).rejects.toThrow('Caller cancelled')
        expect(coordinator.snapshot('withdraw')?.queue).toEqual([])
        expect((await data.dataset('turn_queue').get({ id: second.id }))?.state).toBe('REMOVED')
        release!()
        await coordinator.waitForTurn('withdraw', first.id)
        expect(calls).toEqual(['First'])
      } finally { await coordinator.close() }
    })
  })
})
