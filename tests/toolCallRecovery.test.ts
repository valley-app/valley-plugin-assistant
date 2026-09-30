import { describe, expect, it } from 'vitest'
import { recoverToolCalls } from '../src/agent/toolCallRecovery'

const TOOLS = ['music_play', 'run_command', 'music_control', 'search_vault']

describe('recoverToolCalls', () => {
  it('recovers a bare JSON object with a "parameters" shape (the screenshot payload)', () => {
    const text = '{"name":"run_command","parameters":{"id":"music:clear-queue"}}'
    const { calls, cleanedText } = recoverToolCalls(text, TOOLS)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('run_command')
    expect(calls[0].arguments).toEqual({ id: 'music:clear-queue' })
    expect(cleanedText).toBe('')
  })

  it('recovers an "arguments" shape and keeps the surrounding prose', () => {
    const text = 'Sure, let me do that.\n{"name":"music_play","arguments":{"title":"Orbiter"}}'
    const { calls, cleanedText } = recoverToolCalls(text, TOOLS)
    expect(calls).toHaveLength(1)
    expect(calls[0].arguments).toEqual({ title: 'Orbiter' })
    expect(cleanedText).toBe('Sure, let me do that.')
  })

  it('recovers a <tool_call> tag wrapper', () => {
    const text = '<tool_call>{"name": "music_control", "arguments": {"action": "pause"}}</tool_call>'
    const { calls } = recoverToolCalls(text, TOOLS)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('music_control')
    expect(calls[0].arguments).toEqual({ action: 'pause' })
  })

  it('recovers a fenced ```json block and strips the fence', () => {
    const text = 'Here:\n```json\n{"name":"music_play","arguments":{"playlist":"Focus"}}\n```'
    const { calls, cleanedText } = recoverToolCalls(text, TOOLS)
    expect(calls).toHaveLength(1)
    expect(calls[0].arguments).toEqual({ playlist: 'Focus' })
    expect(cleanedText).toBe('Here:')
  })

  it('handles the OpenAI-style nested {function:{name,arguments}} shape', () => {
    const text = '{"function": {"name": "music_play", "arguments": "{\\"title\\":\\"Canopy Echo\\"}"}}'
    const { calls } = recoverToolCalls(text, TOOLS)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('music_play')
    expect(calls[0].arguments).toEqual({ title: 'Canopy Echo' })
  })

  it('recovers args nested inside arguments with a real object', () => {
    const text = '{"tool":"run_command","args":{"id":"music:play","input":{"title":"Orbiter"}}}'
    const { calls } = recoverToolCalls(text, TOOLS)
    expect(calls[0].arguments).toEqual({ id: 'music:play', input: { title: 'Orbiter' } })
  })

  it('does NOT invent a call from prose that merely names tools', () => {
    const text =
      'You can use the following tools to play Orbiter:\n1. music_play\n2. run_command with music:start.\nPlease try one of these.'
    const { calls, cleanedText } = recoverToolCalls(text, TOOLS)
    expect(calls).toHaveLength(0)
    expect(cleanedText).toBe(text.trim())
  })

  it('recovers a Python-dict-style single-quoted object', () => {
    const text = "{'name': 'music_play', 'arguments': {'title': 'Orbiter'}}"
    const { calls } = recoverToolCalls(text, TOOLS)
    expect(calls).toHaveLength(1)
    expect(calls[0].arguments).toEqual({ title: 'Orbiter' })
  })

  it('ignores JSON whose name is not a known tool', () => {
    const text = '{"name":"not_a_tool","arguments":{"x":1}}'
    const { calls } = recoverToolCalls(text, TOOLS)
    expect(calls).toHaveLength(0)
  })

  it('recovers multiple calls in one message', () => {
    const text =
      '{"name":"music_control","arguments":{"action":"pause"}}\n{"name":"music_play","arguments":{"title":"Canopy Echo"}}'
    const { calls } = recoverToolCalls(text, TOOLS)
    expect(calls.map((c) => c.name)).toEqual(['music_control', 'music_play'])
  })

  it('returns input untouched when there is no JSON at all', () => {
    const { calls, cleanedText } = recoverToolCalls('  just a normal answer  ', TOOLS)
    expect(calls).toHaveLength(0)
    expect(cleanedText).toBe('just a normal answer')
  })
})
