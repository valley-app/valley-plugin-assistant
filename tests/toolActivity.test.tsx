import * as React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ToolActivityRow, ActivityLabel, activitySummary, WorkDuration, formatWorkDuration, useToolActivity, type ActivityStep } from '../src/ToolActivity'
import { buildRenderItems } from '../src/Page'
import { initRuntime } from '../src/runtime'
import { initLocalization } from '../src/localization'
import { createMockValleyApi } from './mock'

const call = vi.fn()
const step: ActivityStep = { runId: 'run', callId: 'parent', name: 'command', state: 'running', timestamp: 1000, startedAt: 1000, arguments: { command: 'npm test', workingDirectory: '/external/project' }, outputRef: 'output' }
beforeEach(() => {
  const { api } = createMockValleyApi()
  call.mockReset().mockImplementation(async (_method, { payload }) => payload.offset === 0
    ? { base64: btoa('first output\n'), nextOffset: 13, done: false }
    : { base64: btoa('last output\n'), nextOffset: 25, done: true })
  api.backend.call = call
  initRuntime(api); initLocalization(api)
})
afterEach(cleanup)

it('never loads a previous conversation output when switching expanded histories', async () => {
  call.mockImplementation(async (_method, { method, payload }) => method === 'list'
    ? { events: [{ ...step, runId: payload.chatId, outputRef: payload.chatId }], nextOffset: 1, done: true }
    : { base64: btoa(`${payload.chatId} output`), nextOffset: 20, done: true })
  function History({ chatId }: { chatId: string }): React.ReactElement {
    const { steps } = useToolActivity(chatId)
    return <>{steps.map(step => <ToolActivityRow key={`${step.runId}:${step.callId}`} step={step} steps={steps} chatId={chatId} expandAll onStop={() => {}} />)}</>
  }
  const { rerender } = render(<History chatId="first" />)
  await screen.findByText('first output')
  rerender(<History chatId="second" />)
  await screen.findByText('second output')
  const reads = call.mock.calls.map(([, input]) => input).filter(input => input.method === 'readOutput')
  expect(reads).toHaveLength(2)
  expect(reads.every(input => input.payload.chatId === input.payload.outputRef)).toBe(true)
  expect(screen.queryByText('first output')).toBeNull()
})

it('expands running and approval steps on request, exposes Stop and pages complete output', async () => {
  const stop = vi.fn()
  const child: ActivityStep = { ...step, callId: 'approval', parentCallId: 'parent', state: 'approval', name: 'Guard approval', outputRef: undefined }
  const { container } = render(<ToolActivityRow step={step} steps={[step, child]} chatId="chat" expandAll onStop={stop} />)
  expect(await screen.findByText('first output')).toBeTruthy()
  for (const row of container.querySelectorAll('details')) {
    row.open = false; fireEvent(row, new Event('toggle'))
    expect(row.open).toBe(true)
  }
  fireEvent.click(screen.getAllByRole('button', { name: 'Stop' })[0])
  expect(stop).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Load more output' }))
  await waitFor(() => expect(screen.getByText(/first output/).textContent).toContain('last output'))
  expect(call).toHaveBeenLastCalledWith('activity.request', { method: 'readOutput', payload: { chatId: 'chat', outputRef: 'output', offset: 13 } })
})

it('defers completed output loading until expanded and preserves failures and readable diffs', async () => {
  const completed: ActivityStep = { ...step, state: 'failed', timestamp: 2500, result: { exitCode: 7, durationMs: 1500 }, diffRef: 'diff' }
  const { container, rerender } = render(<ToolActivityRow step={completed} steps={[completed]} chatId="chat" expandAll={false} onStop={() => {}} />)
  expect(call).not.toHaveBeenCalled()
  expect(container.querySelector('details')?.open).toBe(false)
  rerender(<ToolActivityRow step={completed} steps={[completed]} chatId="chat" expandAll onStop={() => {}} />)
  await waitFor(() => expect(call).toHaveBeenCalledTimes(2))
  expect(call.mock.calls.map(([, value]) => value.payload.outputRef).sort()).toEqual(['diff', 'output'])
  expect(screen.getByText(/"exitCode": 7/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
})

it('groups action categories and opens the exact file without expanding its details', () => {
  const mock = createMockValleyApi()
  initRuntime(mock.api); initLocalization(mock.api)
  expect(activitySummary(['read_file', 'read_file', 'run_command'])).toBe('Read files, Ran commands')
  const { container } = render(<details><summary><ActivityLabel name="read_file" args={{ path: 'forest/canopy.md' }} /></summary></details>)
  fireEvent.click(screen.getByRole('button', { name: 'canopy.md' }))
  expect(mock.api.workspace.openFile).toHaveBeenCalledWith('forest/canopy.md')
  expect(container.querySelector('details')?.open).toBe(false)
})


it('groups transcript and runtime work once per turn while keeping final replies separate', () => {
  const runtime = { ...step, callId: 'read', name: 'read_file', state: 'completed' as const, startedAt: 12, timestamp: 13 }
  const items = buildRenderItems([
    { role: 'user', content: 'Inspect the canopy.', ts: 10 },
    { role: 'assistant', content: 'Reading the file.', ts: 11, activityRunId: 'run', toolCalls: [{ id: 'read', name: 'read_file', arguments: {} }] },
    { role: 'tool', content: 'Leaves', toolCallId: 'read', activityRunId: 'run', ts: 13 },
    { role: 'assistant', content: 'The canopy is healthy.', ts: 14, activityRunId: 'run' },
    { role: 'user', content: 'Inspect the moss.', ts: 20 },
    { role: 'assistant', content: 'The moss is green.', ts: 25, activityRunId: 'next' }
  ], [runtime, { ...runtime, callId: 'child', parentCallId: 'read' }, { ...runtime, runId: 'next', callId: 'write', startedAt: 22, timestamp: 23 }])
  expect(items.map(item => item.kind)).toEqual(['message', 'message', 'activity', 'message', 'message', 'activity', 'message'])
  expect(items[1]).toMatchObject({ kind: 'message', message: { content: 'Reading the file.' } })
  const activities = items.filter(item => item.kind === 'activity')
  expect(activities[0].entries).toHaveLength(1)
  expect(activities[0].entries[0].step?.callId).toBe('read')
  expect(activities[1].entries).toHaveLength(1)
  expect(activities[1].entries[0].step?.callId).toBe('write')
})


it('keeps the opening line above the work and later text between tools inside it', () => {
  const items = buildRenderItems([
    { role: 'user', content: 'Create the note.', ts: 10 },
    { role: 'assistant', content: "I'll create that note, then verify the bytes match exactly.", ts: 11, toolCalls: [{ id: 'create', name: 'file_create', arguments: {} }] },
    { role: 'tool', content: 'ok', toolCallId: 'create', ts: 12 },
    { role: 'assistant', content: 'Checking the size.', ts: 13, toolCalls: [{ id: 'stat', name: 'file_stat', arguments: {} }] },
    { role: 'tool', content: '38 bytes', toolCallId: 'stat', ts: 14 },
    { role: 'assistant', content: 'Created the note (38 bytes, verified).', ts: 15 }
  ])
  expect(items.map(item => item.kind === 'message' ? item.message.content : 'work')).toEqual(['Create the note.', "I'll create that note, then verify the bytes match exactly.", 'work', 'Created the note (38 bytes, verified).'])
  const work = items.find(item => item.kind === 'activity')
  expect(work?.kind === 'activity' && work.entries.map(entry => entry.message?.content ?? entry.call?.id)).toEqual(['create', 'Checking the size.', 'stat'])
})

it('ends a failed turn with its failure reply below the work, not above the request', () => {
  const items = buildRenderItems([
    { role: 'user', content: 'Create the companion note.', ts: 10 },
    { role: 'assistant', content: "I'll create that note now.", ts: 11, toolCalls: [{ id: 'read', name: 'command_execute', arguments: {} }] },
    { role: 'tool', content: '{"success":false}', toolCallId: 'read', ts: 12 },
    { id: 'failure:run', role: 'assistant', content: 'This request failed and did not finish: INVALID_INPUT', failure: 'Error: INVALID_INPUT', error: true, ts: 13 }
  ])
  expect(items.map(item => item.kind === 'message' ? item.message.content : 'work')).toEqual(['Create the companion note.', "I'll create that note now.", 'work', 'This request failed and did not finish: INVALID_INPUT'])
})

it('uses run boundaries for elapsed time instead of adding overlapping tool durations', () => {
  const items = buildRenderItems([
    { role: 'user', content: 'Inspect', ts: 1000 },
    { role: 'assistant', content: 'Done', activityRunId: 'run', ts: 62000 }
  ], [
    { ...step, name: 'deepseek', callId: 'root', startedAt: 2000, timestamp: 63000, state: 'completed' },
    { ...step, callId: 'one', startedAt: 3000, timestamp: 45000, state: 'completed' },
    { ...step, callId: 'two', startedAt: 4000, timestamp: 61000, state: 'completed' }
  ])
  const work = items.find(item => item.kind === 'activity')
  expect(work).toMatchObject({ startedAt: 2000, endedAt: 63000 })
  expect(formatWorkDuration(61000)).toBe('1m 1s')
  expect(formatWorkDuration(3600000)).toBe('1h 0m 0s')
  expect(formatWorkDuration(-100)).toBe('0s')
})

it('ticks only live work, freezes at the recorded end and clears its timer', () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(61000)
    const { rerender, unmount } = render(<WorkDuration startedAt={1000} running />)
    expect(screen.getByText('Working for 1m 0s')).toBeTruthy()
    act(() => vi.advanceTimersByTime(2000))
    expect(screen.getByText('Working for 1m 2s')).toBeTruthy()
    rerender(<WorkDuration startedAt={1000} endedAt={62000} running={false} />)
    expect(screen.getByText('Worked for 1m 1s')).toBeTruthy()
    expect(vi.getTimerCount()).toBe(0)
    rerender(<WorkDuration running={false} />)
    expect(screen.getByText('Work completed')).toBeTruthy()
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
