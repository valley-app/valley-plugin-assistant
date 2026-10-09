import { describe, expect, it } from 'vitest'
import { commandResult } from '../../src/backend/tools/commandResult'

const execution = { id: 'execution-fern', command: 'notes.write', revision: 2, status: 'completed', result: { written: true } }
describe('command terminal results', () => {
  it('reports success only for completed execution records', () => {
    expect(commandResult(execution)).toEqual(execution)
    expect(commandResult({ status: 'running', custom: true })).toEqual({ status: 'running', custom: true })
  })
  it.each(['accepted', 'running', 'awaiting-approval', 'cancel-requested', 'uncertain'])('preserves %s as an unknown accepted outcome', status => {
    try { commandResult({ ...execution, status }); throw new Error('Expected incomplete execution') }
    catch (error) { expect(error).toMatchObject({ outcome: 'unknown', execution: { id: execution.id, status } }) }
  })
  it.each(['failed', 'cancelled'])('rejects %s without pretending the effect completed', status => {
    expect(() => commandResult({ ...execution, status, error: { code: 'GUARD_DENIED', message: 'Denied by Guard' } })).toThrow('Denied by Guard')
  })
  it('keeps an explicitly unknown failure unknown', () => {
    try { commandResult({ ...execution, status: 'failed', error: { outcome: 'unknown' } }); throw new Error('Expected incomplete execution') }
    catch (error) { expect(error).toMatchObject({ outcome: 'unknown' }) }
  })
})
