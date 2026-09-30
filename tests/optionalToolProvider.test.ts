import { describe, expect, it, vi } from 'vitest'
import { AGENT_TOOL_PROVIDER_V1, createAgentToolProvider } from '@valley/plugin-sdk'
import { createMockValleyApi } from './mock'
import { buildTools } from '../src/agent/tools'

describe('optional provider-owned agent tools', () => {
  it('discovers an arbitrary provider and forwards input through the SDK service', async () => {
    const mock = createMockValleyApi()
    const run = vi.fn(async () => ({ text: 'Image', attachment: { mime: 'image/png', dataBase64: 'Zm9yZXN0' } }))
    mock.provideInterop(AGENT_TOOL_PROVIDER_V1, createAgentToolProvider([{ name: 'inspect_page', description: 'Inspect a page', parameters: { type: 'object' }, sideEffect: 'read', run }]), 'renamed-provider')
    const tool = buildTools(mock.api).find((item) => item.name === 'inspect_page')!
    expect(tool.providerOwner).toBe('renamed-provider')
    expect(await tool.run({ page: 'one' })).toEqual({ text: 'Image', attachment: { mime: 'image/png', dataBase64: 'Zm9yZXN0' } })
    expect(run).toHaveBeenCalledWith({ page: 'one' }, expect.any(Object))
    expect(mock.driverCalls.some((item) => item.driver === 'browser')).toBe(false)
  })

  it('retains provider ownership for command guards and rejects calls after provider removal', async () => {
    const mock = createMockValleyApi()
    const run = vi.fn(async () => 'done')
    const dispose = mock.provideInterop(AGENT_TOOL_PROVIDER_V1, createAgentToolProvider([{ name: 'change_page', description: 'Change a page', parameters: { type: 'object' }, commandId: 'change', sideEffect: 'write', run }]), 'renamed-provider')
    const tool = buildTools(mock.api).find((item) => item.name === 'change_page')!
    expect(tool.busCommandId?.({})).toBe('renamed-provider:change')
    dispose()
    expect(String(await tool.run({}))).toMatch(/unavailable/i)
    expect(run).not.toHaveBeenCalled()
    expect(buildTools(mock.api).some((item) => item.name === 'change_page')).toBe(false)
  })
})
