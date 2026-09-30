import { describe, expect, it } from 'vitest'
import { aiDriver } from '../src/backend/aiRpc'
describe('Assistant shared AI boundary', () => {
  it('accepts an explicit connection and keeps chat selection independent', () => {
    const base = { requestId: 'r1', provider: 'openai', model: 'gpt-4o', messages: [] }
    expect(() => aiDriver.chat.schema.parse(base)).not.toThrow()
    expect(() => aiDriver.chat.schema.parse({ ...base, connectionId: 'openai-2' })).not.toThrow()
    expect(() => aiDriver.chat.schema.parse({ ...base, connectionId: '../nope' })).toThrow()
  })
  it('does not expose global provider or usage mutations through Assistant', () => {
    for (const name of ['addConnection', 'setConnectionKey', 'removeConnection', 'resetUsage', 'setBudget', 'saveGuardPolicy']) expect(aiDriver).not.toHaveProperty(name)
  })
})
