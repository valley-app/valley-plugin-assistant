import { afterEach, describe, expect, it, vi } from 'vitest'
import { isSimpleLocalAction, runResponsiveTurn, type TurnProgress } from '../../src/backend/engine/responsiveness'
import type { RunControls } from '../../src/backend/engine/coordinator'
import { SessionCoordinator } from '../../src/backend/engine/coordinator'
import { AssistantRepository } from '../../src/backend/persistence/repositories'
import { datasetFixture } from '../backendDatasetFixture'

const never = () => new Promise<void>(() => {})
function controls() {
  const controller = new AbortController()
  const value: RunControls = { signal: controller.signal, shouldSteer: () => false, state: vi.fn(async () => {}), message: vi.fn(async () => {}), stream: vi.fn(async () => {}), context: vi.fn(async () => {}), update: vi.fn(async () => {}) }
  return { controller, value }
}
afterEach(() => vi.useRealTimers())

describe('simple local action responsiveness', () => {
  it.each(['open the calendar app in a new tab', 'Please read Notes/fern.md', 'Create a note named Plants', 'rename the file fern.md to moss.md'])('selects only a responsiveness budget for %s', text => {
    expect(isSimpleLocalAction({ id: 'turn', conversationId: 'chat', text }, false)).toBe(true)
  })
  it.each(['"open the calendar app"', 'Explain "open the app"', 'Plan how to open a new tab', 'Open the app and write a plugin', 'Create a website', 'Write a script to move every file', 'Research the file format', 'open the app\nthen edit a note'])('keeps broad work outside the simple-action budget: %s', text => {
    expect(isSimpleLocalAction({ id: 'turn', conversationId: 'chat', text }, false)).toBe(false)
  })
  it('excludes plans and attachment interpretation', () => {
    const turn = { id: 'turn', conversationId: 'chat', text: 'open the file' }
    expect(isSimpleLocalAction(turn, true)).toBe(false)
    expect(isSimpleLocalAction({ ...turn, attachments: [{ path: 'fern.png', fileName: 'fern.png', kind: 'image' }] }, false)).toBe(false)
  })
  it.each(['Create a note with exactly:\nFern and moss\nReadiness ready', 'Write the note with the quoted text "open the app and research the folder"'])('still bounds preparation and inference for non-simple input: %s', async text => {
    vi.useFakeTimers()
    expect(isSimpleLocalAction({ id: 'turn', conversationId: 'chat', text }, false)).toBe(false)
    const test = controls()
    const task = runResponsiveTurn(test.value, async (_guarded, progress) => { progress.stage('waiting for provider output'); await never() })
    const rejected = expect(task).rejects.toThrow('waiting for provider output for 10 seconds')
    await vi.advanceTimersByTimeAsync(10000)
    await rejected
  })
  it('ends a never-settling turn at ten seconds and fences late state and messages', async () => {
    vi.useFakeTimers()
    const test = controls()
    let late!: RunControls
    const task = runResponsiveTurn(test.value, async (guarded, progress) => { late = guarded; progress.stage('waiting for provider output'); await never() })
    const rejected = expect(task).rejects.toThrow('No progress while waiting for provider output for 10 seconds')
    await vi.advanceTimersByTimeAsync(10000)
    await rejected
    expect(late.signal.aborted).toBe(true)
    await expect(late.message({ role: 'assistant', content: 'Late answer' })).rejects.toThrow('No progress')
    await expect(late.state('INFERRING')).rejects.toThrow('No progress')
    expect(test.value.message).not.toHaveBeenCalled()
    expect(test.value.state).not.toHaveBeenCalled()
  })
  it('resets only on explicit substantive progress and retains selected long-action deadlines', async () => {
    vi.useFakeTimers()
    const test = controls()
    let progress!: TurnProgress
    const task = runResponsiveTurn(test.value, async (_guarded, value) => { progress = value; await never() })
    const rejected = expect(task).rejects.toThrow('executing a declared long action for 60 seconds')
    await vi.advanceTimersByTimeAsync(9000)
    progress.advance()
    await vi.advanceTimersByTimeAsync(9000)
    progress.stage('executing a declared long action', 60000)
    await vi.advanceTimersByTimeAsync(59999)
    expect(test.controller.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
  })
  it('preserves an explicitly selected long action and Stop settles without joining its promise', async () => {
    vi.useFakeTimers()
    const test = controls()
    let settled = false
    const task = runResponsiveTurn(test.value, async (_guarded, progress) => { progress.stage('running a terminal command', 300000); await never() }).finally(() => { settled = true })
    const rejected = expect(task).rejects.toThrow('Conversation cancelled')
    await vi.advanceTimersByTimeAsync(120000)
    expect(settled).toBe(false)
    test.controller.abort()
    await rejected
    expect(settled).toBe(true)
  })
  it('reports failure, permits a fresh turn and restores without replaying the stalled turn', async () => {
    vi.useFakeTimers()
    const repository = new AssistantRepository(datasetFixture())
    let late!: RunControls
    const run = vi.fn(async (_session, turn, controls: RunControls) => runResponsiveTurn(controls, async guarded => {
      if (turn?.id === 'stalled') { late = guarded; await never() }
      else await guarded.message({ role: 'assistant', content: 'New turn finished' })
    }))
    const ports = { run, project: vi.fn(async () => {}), publish: vi.fn() }
    const coordinator = new SessionCoordinator(repository, ports)
    const thread = { id: 'chat', title: 'Chat', createdAt: 1, updatedAt: 1, messages: [] }
    await coordinator.enqueue({ id: 'stalled', conversationId: 'chat', text: 'open the app', thread })
    const failed = expect(coordinator.waitForTurn('chat', 'stalled')).rejects.toThrow('No progress')
    await vi.advanceTimersByTimeAsync(10000)
    await failed
    expect(coordinator.snapshot('chat')).toMatchObject({ state: 'FAILED', paused: true })
    const restored = new SessionCoordinator(repository, ports)
    await restored.restore()
    expect(run).toHaveBeenCalledTimes(1)
    await coordinator.enqueue({ id: 'new', conversationId: 'chat', text: 'read the note' })
    await coordinator.steer('chat', 'new')
    await coordinator.waitForTurn('chat', 'new')
    await expect(late.stream('Old output')).rejects.toThrow('No progress')
    expect(coordinator.snapshot('chat')).toMatchObject({ state: 'IDLE', error: null, streamingText: '' })
    expect(coordinator.snapshot('chat')?.thread?.messages).toEqual([expect.objectContaining({ content: 'New turn finished' })])
    await coordinator.close(); await restored.close()
  })
})
