import { describe, expect, it } from 'vitest'
import { executeProjectCommand } from '../src/backend/projectExecution'

describe('project command input', () => {
  it('reports a missing working directory as not started, so the model can correct it', async () => {
    const error = await executeProjectCommand({ chatId: 'chat', command: 'ls', rootId: undefined }, {} as never).catch(failure => failure)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ code: 'INVALID_INPUT', outcome: 'not-applied' })
    expect(error.message).toBe('The terminal command was not started: rootId required. No working directory is available in this conversation; use the vault file commands instead.')
  })
})
