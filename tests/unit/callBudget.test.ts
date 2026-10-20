import { describe, expect, it } from 'vitest'
import { callBudget } from '../../src/backend/engine/callBudget'

const call = (command: string, input: unknown = {}) => ({ name: 'command_execute', arguments: { command, arguments: input } })

describe('turn call budget (readiness 4.9)', () => {
  it('stops an unsupported call on its third try, whatever the input', () => {
    const budget = callBudget()
    expect(budget.record(call('music.shuffle', { a: 1 }), { code: 'EXECUTION_FAILED', message: 'Error: Command is unavailable' })).toBeUndefined()
    expect(budget.record(call('music.shuffle', { a: 2 }), { code: 'EXECUTION_FAILED', message: 'Error: Command is unavailable' })).toBeUndefined()
    expect(budget.record(call('music.shuffle', { a: 3 }), { code: 'EXECUTION_FAILED', message: 'Error: Command is unavailable' })).toMatch('not available here and was tried 3 times')
    const tools = callBudget()
    for (let i = 0; i < 2; i++) expect(tools.record({ name: 'missing_tool', arguments: { i } }, { code: 'UNKNOWN_TOOL', message: 'Unknown tool missing_tool' })).toBeUndefined()
    expect(tools.record({ name: 'missing_tool', arguments: { i: 3 } }, { code: 'UNKNOWN_TOOL', message: 'Unknown tool missing_tool' })).toMatch('missing_tool is not available')
  })
  it('stops the same input failing the same way on its third try', () => {
    const budget = callBudget(), failure = { code: 'REVISION_CONFLICT', message: 'Revision changed' }
    expect(budget.record(call('notes.write', { revision: 1 }), failure)).toBeUndefined()
    expect(budget.record(call('notes.write', { revision: 1 }), failure)).toBeUndefined()
    expect(budget.record(call('notes.write', { revision: 1 }), failure)).toMatch('failed the same way 3 times')
  })
  it('keeps legitimate input and conflict corrections going, but not forever', () => {
    const budget = callBudget()
    for (let revision = 1; revision <= 5; revision++) expect(budget.record(call('notes.write', { revision }), { code: revision % 2 ? 'INVALID_INPUT' : 'REVISION_CONFLICT', message: `try ${revision}` })).toBeUndefined()
    expect(budget.record(call('notes.write', { revision: 6 }))).toBeUndefined()
    for (let revision = 7; revision <= 11; revision++) expect(budget.record(call('notes.write', { revision }), { code: 'INVALID_INPUT', message: `try ${revision}` })).toBeUndefined()
    expect(budget.record(call('notes.write', { revision: 12 }), { code: 'INVALID_INPUT', message: 'try 12' })).toMatch('still failed after 6 corrections in a row')
  })
  it('counts each command separately', () => {
    const budget = callBudget(), failure = { code: 'UNKNOWN_TOOL', message: 'Unknown tool' }
    budget.record(call('a'), failure); budget.record(call('a', { x: 1 }), failure)
    expect(budget.record(call('b'), failure)).toBeUndefined()
  })
})
