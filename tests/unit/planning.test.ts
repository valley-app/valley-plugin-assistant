import { describe, expect, it, vi } from 'vitest'
import { allowedWhilePlanning, planningTool } from '../../src/backend/tools/catalog/general/planning'
import type { AgentTool } from '../../src/agent/tools'

describe('planning tools', () => {
  it('validates a complete plan before publishing it for review', async () => {
    const present = vi.fn(async () => {}), tool = planningTool(present)
    await expect(tool.run({ plan: '  ' })).rejects.toThrow()
    await expect(tool.run({ plan: 'Inspect fern specimens', approved: true })).rejects.toThrow()
    await tool.run({ plan: '  Inspect fern specimens  ' })
    expect(present).toHaveBeenCalledTimes(1)
    expect(present).toHaveBeenCalledWith('Inspect fern specimens')
  })
  it('blocks writes and indirect dispatch regardless of broad permissions', () => {
    const read: AgentTool = { name: 'read_file', sideEffect: 'read', description: '', parameters: {}, run: async () => '' }
    expect(allowedWhilePlanning(read)).toBe(true)
    for (const tool of [{ ...read, sideEffect: 'write' as const }, { ...read, dispatch: 'bus' as const }, { ...read, providerOwner: 'provider' }, { ...read, name: 'send_attachment' }, { ...read, name: 'quiz_next' }]) expect(allowedWhilePlanning(tool)).toBe(false)
  })
})
