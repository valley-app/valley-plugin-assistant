import type { ValleyPluginApi } from '../src/api'
import { describe, expect, it, vi } from 'vitest'
import type { AiMessage, AiStreamEvent, AssistantConfig } from '../src/types'
import type { GuardPolicy } from '@valley/plugin-sdk/guard/types'
import { createMockValleyApi, type MockValleyApi } from './mock'
import { runAgent, streamOnce, boundContext, friendlyStreamError } from '../src/agent/loop'
import type { AiChatRequest } from '../src/types'
import {
  AGENT_TOOL_PROVIDER_V1,
  createAgentToolProvider
} from '@valley/plugin-sdk'
import { buildTools } from '../src/agent/tools'

const guard: GuardPolicy = {
  defaultWrite: { decision: 'confirm', allowPreApproval: false },
  tools: {},
  commands: {},
  files: {
    visitMode: 'allow-all-except-blocked',
    defaultRead: { decision: 'allow' },
    defaultWrite: { decision: 'confirm', allowPreApproval: false },
    allowedToVisit: ['**/*'],
    allowedToWrite: ['**/*.md'],
    blocked: ['.valley/assistant', '.valley/**/secrets.json'],
    readOverrides: {},
    writeOverrides: {}
  },
  dangerousMode: { enabled: false, scope: 'off' },
  pluginPresets: {}
}

const config: AssistantConfig = {
  instructions: '',
  rules: [],
  routing: { auto: false, default: { provider: 'anthropic', model: 'claude-opus-4-8' }, rules: [] },
  guard,
  providers: [],
  connections: [{ id: 'anthropic', provider: 'anthropic', label: 'Fixture', providerName: 'Fixture', providerDescription: '', providerIcon: '', requiresKey: true, providerCapabilities: [], baseUrl: '', configured: true, authMode: 'key', models: [{ provider: 'anthropic', id: 'claude-opus-4-8', label: 'Fixture' }], createdAt: 1 }]
}

/**
 * `Omit` over a union keeps only the members' *common* keys, so a plain
 * `Omit<AiStreamEvent, 'requestId'>` erases `text`/`call` and leaves every step
 * below typed as bare `{ type }`. Distribute it so each variant survives.
 */
type StreamStep<T> = T extends unknown ? Omit<T, 'requestId'> : never

/** Wire per-step fake stream emission keyed off each run's requestId. */
function scripted(mock: MockValleyApi, steps: StreamStep<AiStreamEvent>[][]): (id: string) => void {
  let i = 0
  return (id: string) => {
    const events = steps[i++] ?? []
    queueMicrotask(() => {
      for (const e of events) mock.emitAiStream({ ...e, requestId: id } as AiStreamEvent)
      mock.emitAiStream({ requestId: id, type: 'done' })
    })
  }
}

function run(mock: MockValleyApi, messages: AiMessage[], onRequestStart: (id: string) => void, extra: Partial<Parameters<typeof runAgent>[0]> = {}) {
  const out: AiMessage[] = []
  return runAgent({
    api: mock.api,
    config,
    systemPrompt: 'sys',
    messages,
    tools: buildTools(mock.api),
    onText: () => {},
    onMessage: (m) => out.push(m),
    requestApproval: async () => true,
    isCancelled: () => false,
    onRequestStart,
    ...extra
  }).then(() => out)
}

describe('agent loop', () => {
  it('completes a plain text turn in one step', async () => {
    const mock = createMockValleyApi()
    const out = await run(mock, [{ role: 'user', content: 'hi' }], scripted(mock, [[{ type: 'text', text: 'Hello!' }]]))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ role: 'assistant', content: 'Hello!' })
  })

  it('excludes render-only messages (quiz images) from the provider context', async () => {
    const mock = createMockValleyApi()
    await run(
      mock,
      [
        { role: 'user', content: 'quiz me' },
        { role: 'assistant', content: '![[q.jpg]]', render: 'quiz-image' }
      ],
      scripted(mock, [[{ type: 'text', text: 'ok' }]])
    )
    const chat = mock.driverCalls.find((c) => c.driver === 'ai' && c.method === 'chat')!
    const sent = (chat.payload as { messages: AiMessage[] }).messages
    expect(sent.some((m) => m.render === 'quiz-image')).toBe(false)
    expect(sent.some((m) => m.content === '![[q.jpg]]')).toBe(false)
  })

  it('executes a tool call and feeds the result back', async () => {
    const mock = createMockValleyApi({ files: { 'a.md': 'CONTENT' } })
    const out = await run(
      mock,
      [{ role: 'user', content: 'read a.md' }],
      scripted(mock, [
        [{ type: 'text', text: 'Reading.' }, { type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: 'a.md' } } }],
        [{ type: 'text', text: 'It says CONTENT.' }]
      ])
    )
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant'])
    expect(out[1].content).toContain('CONTENT')
    expect(out[2].content).toBe('It says CONTENT.')
  })

  it('injects a provider-owned tool image as a provider-visible message', async () => {
    const mock = createMockValleyApi()
    mock.provideInterop(
      AGENT_TOOL_PROVIDER_V1,
      createAgentToolProvider([{
        name: 'capture_habitat_image',
        description: 'Capture a synthetic habitat image for visual inspection.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        sideEffect: 'read',
        run: async () => ({
          text: 'Captured a forest habitat image.',
          attachment: { mime: 'image/png', dataBase64: 'ZmVybg==' }
        })
      }]),
      'biodiversity'
    )
    const out = await run(
      mock,
      [{ role: 'user', content: 'show the forest habitat' }],
      scripted(mock, [
        [{ type: 'tool_call', call: { id: 'c1', name: 'capture_habitat_image', arguments: {} } }],
        [{ type: 'text', text: 'I can see it.' }]
      ])
    )
    // The tool result stays text; an extra user message carries the image.
    expect(out.find((m) => m.role === 'tool')?.content).toMatch(/habitat image/i)
    const img = out.find((m) => m.role === 'user' && m.attachments?.length)
    expect(img?.attachments?.[0]?.mime).toBe('image/png')
    // And it actually reaches the provider on the following turn.
    const chats = mock.driverCalls.filter((c) => c.driver === 'ai' && c.method === 'chat')
    const lastSent = (chats.at(-1)!.payload as { messages: AiMessage[] }).messages
    expect(lastSent.some((m) => m.role === 'user' && m.attachments?.some((a) => a.mime === 'image/png'))).toBe(true)
  })

  it('runs permitted Telegram writes in Full access without approval and retains explicit blocks', async () => {
    const mock = createMockValleyApi()
    const requestApproval = vi.fn(async () => false)
    const fullAccess = { ...config, guard: { ...guard, dangerousMode: { enabled: true, scope: 'session' as const } } }
    const out = await run(mock, [{ role: 'user', content: 'Record the moss observation' }], scripted(mock, [
      [{ type: 'tool_call', call: { id: 'c1', name: 'write_note', arguments: { path: 'moss.md', content: 'Moss habitat' } } }],
      [{ type: 'text', text: 'Recorded.' }]
    ]), { config: fullAccess, origin: 'channel', requestApproval })
    expect(requestApproval).not.toHaveBeenCalled()
    expect(out.at(-1)?.content).toBe('Recorded.')
    expect(await mock.api.drivers.files.readFile('moss.md')).toMatchObject({ ok: true, data: { content: 'Moss habitat' } })
    const denied = await run(mock, [{ role: 'user', content: 'Write outside the permitted folders' }], scripted(mock, [
      [{ type: 'tool_call', call: { id: 'c2', name: 'write_note', arguments: { path: 'moss.txt', content: 'Moss habitat' } } }],
      [{ type: 'text', text: 'Blocked.' }]
    ]), { config: fullAccess, origin: 'channel', requestApproval })
    expect(denied.find(message => message.role === 'tool')?.content).toContain('Blocked by policy')
    expect(requestApproval).not.toHaveBeenCalled()
    expect(mock.driverCalls.some(call => call.method === 'writeFile' && (call.payload as { path?: string }).path === 'moss.txt')).toBe(false)
  })

  it('gates a write tool behind confirm and skips when denied', async () => {
    const mock = createMockValleyApi()
    const requestApproval = vi.fn(async () => false)
    const out = await run(
      mock,
      [{ role: 'user', content: 'write a note' }],
      scripted(mock, [[{ type: 'tool_call', call: { id: 'c1', name: 'write_note', arguments: { path: 'n.md', content: 'x' } } }], [{ type: 'text', text: 'Skipped.' }]]),
      { requestApproval }
    )
    expect(requestApproval).toHaveBeenCalled()
    expect(out.find((m) => m.role === 'tool')?.content).toContain('declined')
    expect(mock.driverCalls.some((c) => c.driver === 'notes')).toBe(false)
  })

  it.each(['relay-42', 'whatsapp-2'])('gates channel %s without encoding its adapter as a caller', async (channelId) => {
    const mock = createMockValleyApi()
    const requestApproval = vi.fn(async () => false)
    const audit = vi.fn()
    await run(mock, [{ role: 'user', content: 'write a note' }], scripted(mock, [
      [{ type: 'tool_call', call: { id: 'c1', name: 'write_note', arguments: { path: 'n.md', content: 'x' } } }],
      [{ type: 'text', text: 'Skipped.' }]
    ]), { origin: 'channel', channel: { channelId, chatRef: 'remote-thread' }, conversationId: 'saved-thread', requestApproval, audit })
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ caller: 'channel', channelId }))
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ caller: 'channel', channelId, chatId: 'saved-thread', decision: 'deny' }))
    expect(mock.driverCalls.some((call) => call.driver === 'notes')).toBe(false)
  })

  it('refuses workspace:save-active / workspace:deselect outright, never prompting for approval', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'workspace' } })
    for (const id of ['save-active', 'deselect']) {
      mock.api.commands.register({
        id,
        label: `Workspace: ${id}`,
        sideEffect: 'write',
        agentVisibility: 'forbidden',
        run: async () => ({ value: null, revert: null })
      })
    }
    const requestApproval = vi.fn(async () => true)
    const out = await run(
      mock,
      [{ role: 'user', content: 'do something unrelated' }],
      scripted(mock, [
        [
          { type: 'tool_call', call: { id: 'c1', name: 'run_command', arguments: { id: 'workspace:save-active' } } },
          { type: 'tool_call', call: { id: 'c2', name: 'run_command', arguments: { id: 'workspace:deselect' } } }
        ],
        [{ type: 'text', text: 'Done.' }]
      ]),
      { requestApproval }
    )
    expect(requestApproval).not.toHaveBeenCalled()
    const toolMsgs = out.filter((m) => m.role === 'tool')
    expect(toolMsgs[0].content).toMatch(/isn't available to the assistant/i)
    expect(toolMsgs[1].content).toMatch(/isn't available to the assistant/i)
  })

  it('surfaces a provider error as an assistant message', async () => {
    const mock = createMockValleyApi()
    const out = await run(mock, [{ role: 'user', content: 'hi' }], (id) =>
      queueMicrotask(() => {
        mock.emitAiStream({ requestId: id, type: 'error', error: 'boom' })
        mock.emitAiStream({ requestId: id, type: 'done' })
      })
    )
    expect(out.at(-1)?.content).toContain('boom')
  })

  it('routes channel turns by the normal routing, not a forced OpenAI-cheap model (C7)', async () => {
    const mock = createMockValleyApi()
    let picked: { provider: string; model: string } | null = null
    await run(mock, [{ role: 'user', content: 'hi' }], scripted(mock, [[{ type: 'text', text: 'Hello!' }]]), {
      origin: 'channel',
      onModel: (routed) => {
        picked = routed
      }
    })
    // The hard-coded channel→OpenAI-cheap branch is gone; a channel turn now uses
    // config.routing's default exactly like an in-app turn.
    expect(picked).toMatchObject({ provider: 'anthropic', model: 'claude-opus-4-8' })
  })

  it('keeps manual channel model overrides exact', async () => {
    const mock = createMockValleyApi()
    let picked: { provider: string; model: string } | null = null
    await run(mock, [{ role: 'user', content: 'hi' }], scripted(mock, [[{ type: 'text', text: 'Hello!' }]]), {
      origin: 'channel',
      modelOverride: { provider: 'openai', model: 'gpt-4o' },
      config: {
        ...config,
        // A configured provider that is NOT the override target, listed first:
        // the override must still be honoured exactly rather than falling back
        // to whatever heads the list.
        providers: [
          { provider: 'anthropic', configured: true, models: [{ provider: 'anthropic', id: 'claude-opus-4-8' }] },
          { provider: 'openai', configured: true, models: [{ provider: 'openai', id: 'gpt-4o' }] }
        ]
      },
      onModel: (routed) => {
        picked = routed
      }
    })
    expect(picked).toMatchObject({ provider: 'openai', model: 'gpt-4o' })
  })

  it('recovers a tool call a weak model emitted as text (no structured call)', async () => {
    const mock = createMockValleyApi({ files: { 'a.md': 'CONTENT' } })
    const out = await run(
      mock,
      [{ role: 'user', content: 'read a.md' }],
      scripted(mock, [
        // The model wrote the call into its content instead of calling the tool.
        [{ type: 'text', text: 'Sure.\n{"name":"read_file","arguments":{"path":"a.md"}}' }],
        [{ type: 'text', text: 'It says CONTENT.' }]
      ])
    )
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant'])
    // The raw JSON is stripped from the visible assistant message.
    expect(out[0].content).toBe('Sure.')
    expect(out[0].toolCalls?.[0]).toMatchObject({ name: 'read_file' })
    expect(out[1].content).toContain('CONTENT')
  })

  it('tells the model to change course when it repeats the exact same failing call', async () => {
    const mock = createMockValleyApi()
    const out = await run(
      mock,
      [{ role: 'user', content: 'do the thing' }],
      scripted(mock, [
        [{ type: 'tool_call', call: { id: 'c1', name: 'run_command', arguments: { id: 'bogus:cmd' } } }],
        [{ type: 'tool_call', call: { id: 'c2', name: 'run_command', arguments: { id: 'bogus:cmd' } } }],
        [{ type: 'text', text: 'Giving up.' }]
      ])
    )
    const toolMsgs = out.filter((m) => m.role === 'tool')
    expect(toolMsgs[0].content).toMatch(/No such command/i)
    expect(toolMsgs[1].content).toMatch(/already tried this exact/i)
  })

  it('stops after repeated all-failed steps instead of spinning to the cap', async () => {
    const mock = createMockValleyApi()
    let n = 0
    const out = await run(
      mock,
      [{ role: 'user', content: 'keep failing' }],
      // A distinct failing command each step so the dedupe path isn't what stops it.
      (id) =>
        queueMicrotask(() => {
          mock.emitAiStream({ requestId: id, type: 'tool_call', call: { id: `c${n}`, name: 'run_command', arguments: { id: `bogus:cmd${n++}` } } })
          mock.emitAiStream({ requestId: id, type: 'done' })
        })
    )
    expect(out.at(-1)?.content).toMatch(/couldn't complete/i)
    // Broke well before the 12-step cap.
    expect(out.filter((m) => m.role === 'tool').length).toBeLessThan(12)
  })

  it('stops at the step cap', async () => {
    const mock = createMockValleyApi()
    let n = 0
    const out = await run(
      mock,
      [{ role: 'user', content: 'loop forever' }],
      (id) =>
        queueMicrotask(() => {
          mock.emitAiStream({ requestId: id, type: 'tool_call', call: { id: `c${n++}`, name: 'search_vault', arguments: { query: 'x' } } })
          mock.emitAiStream({ requestId: id, type: 'done' })
        }),
      { maxSteps: 2 }
    )
    expect(out.at(-1)?.content).toContain('step limit')
  })
})

describe('approval audit on cancellation', () => {
  it('audits a cancellation-resolved approval as skipped (not deny)', async () => {
    const mock = createMockValleyApi()
    let cancelled = false
    const audits: import('@valley/plugin-sdk/guard/types').GuardAuditEntry[] = []
    await run(
      mock,
      [{ role: 'user', content: 'write' }],
      scripted(mock, [
        [{ type: 'tool_call', call: { id: 'c1', name: 'write_note', arguments: { path: 'a.md', content: 'x' } } }],
        [{ type: 'text', text: 'never reached' }]
      ]),
      {
        isCancelled: () => cancelled,
        requestApproval: async () => {
          // The user stops the run while this approval is parked: the store
          // resolves the pending promise false with the run already cancelled.
          cancelled = true
          return false
        },
        audit: (e) => audits.push(e)
      }
    )
    expect(audits.some((e) => e.decision === 'skipped')).toBe(true)
    expect(audits.some((e) => e.decision === 'deny')).toBe(false)
  })

  it('audits a user decline (run not cancelled) as deny', async () => {
    const mock = createMockValleyApi()
    const audits: import('@valley/plugin-sdk/guard/types').GuardAuditEntry[] = []
    await run(
      mock,
      [{ role: 'user', content: 'write' }],
      scripted(mock, [
        [{ type: 'tool_call', call: { id: 'c1', name: 'write_note', arguments: { path: 'a.md', content: 'x' } } }],
        [{ type: 'text', text: 'ok' }]
      ]),
      {
        requestApproval: async () => false,
        audit: (e) => audits.push(e)
      }
    )
    expect(audits.some((e) => e.decision === 'deny')).toBe(true)
    expect(audits.some((e) => e.decision === 'skipped')).toBe(false)
  })
})

describe('boundContext', () => {
  it('returns the array untouched when within budget', () => {
    const msgs: AiMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ]
    const out = boundContext(msgs, 1000)
    expect(out.messages).toBe(msgs)
    expect(out.trimmed).toBe(0)
  })

  it('drops oldest whole messages, reports the trim count, and keeps the first user message', () => {
    const msgs: AiMessage[] = [
      { role: 'user', content: 'original task' },
      { role: 'assistant', content: 'y'.repeat(200) },
      { role: 'assistant', content: 'z'.repeat(200) },
      { role: 'user', content: 'latest question' },
      { role: 'assistant', content: 'answer' }
    ]
    const out = boundContext(msgs, 260)
    expect(out.trimmed).toBe(2)
    // The marker is the caller's job (folded into the system prompt) — the list
    // itself must never grow a second `system` entry.
    expect(out.messages.some((m) => m.role === 'system')).toBe(false)
    expect(out.messages[0].content).toBe('original task')
    expect(out.messages.some((m) => m.content === 'latest question')).toBe(true)
    expect(out.messages.some((m) => m.content === 'answer')).toBe(true)
  })

  it('never leaves an orphan tool result at the head of the kept tail', () => {
    const msgs: AiMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'z'.repeat(300), toolCalls: [{ id: 't', name: 'read_file', arguments: {} }] },
      { role: 'tool', toolCallId: 't', name: 'read_file', content: 'w'.repeat(50) },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'done' }
    ]
    const out = boundContext(msgs, 300)
    expect(out.messages[0].content).toBe('q1')
    expect(out.messages[1]?.role).not.toBe('tool')
  })

  it('folds the trim marker into the single system prompt (never two system messages)', async () => {
    const mock = createMockValleyApi()
    const big = 'b'.repeat(200_000)
    await run(
      mock,
      [
        { role: 'user', content: 'the original task' },
        { role: 'assistant', content: big },
        { role: 'user', content: 'follow-up' }
      ],
      scripted(mock, [[{ type: 'text', text: 'ok' }]])
    )
    const chat = mock.driverCalls.find((c) => c.driver === 'ai' && c.method === 'chat')!
    const sent = (chat.payload as AiChatRequest).messages
    expect(sent.filter((m) => m.role === 'system')).toHaveLength(1)
    expect(sent[0].role).toBe('system')
    expect(sent[0].content).toMatch(/trimmed to fit the context budget/)
    expect(sent.some((m) => m.content === 'the original task')).toBe(true)
    expect(sent.some((m) => m.content === 'follow-up')).toBe(true)
    expect(sent.some((m) => m.content === big)).toBe(false)
  })
})

describe('tool run hardening', () => {
  it('a hanging tool times out into failure text instead of wedging the turn', async () => {
    vi.useFakeTimers()
    const mock = createMockValleyApi()
    const tools = buildTools(mock.api)
    const hang = tools.find((t) => t.name === 'read_file')!
    const original = hang.run
    hang.run = () => new Promise(() => {}) // never resolves
    const out: AiMessage[] = []
    const p = runAgent({
      api: mock.api,
      config,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'read a.md' }],
      tools,
      onText: () => {},
      onMessage: (m) => out.push(m),
      requestApproval: async () => true,
      isCancelled: () => false,
      onRequestStart: scripted(mock, [
        [{ type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: 'a.md' } } }],
        [{ type: 'text', text: 'gave up' }]
      ])
    }).then(() => out)
    await vi.advanceTimersByTimeAsync(61_000)
    await vi.runAllTimersAsync()
    const result = await p
    const toolMsg = result.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toMatch(/timed out/)
    hang.run = original
    vi.useRealTimers()
  })

  it('stops before the next tool call once cancelled mid-step', async () => {
    const mock = createMockValleyApi({ files: { 'a.md': 'A', 'b.md': 'B' } })
    let cancelled = false
    const out: AiMessage[] = []
    await runAgent({
      api: mock.api,
      config,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'read both' }],
      tools: buildTools(mock.api),
      onText: () => {},
      onMessage: (m) => {
        out.push(m)
        if (m.role === 'tool') cancelled = true // cancel right after the first tool result
      },
      requestApproval: async () => true,
      isCancelled: () => cancelled,
      onRequestStart: scripted(mock, [
        [
          { type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: 'a.md' } } },
          { type: 'tool_call', call: { id: 'c2', name: 'read_file', arguments: { path: 'b.md' } } }
        ]
      ])
    })
    // Only the first tool ran; the second was skipped by the cancel check.
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(1)
  })
})

describe('streamOnce hang-proofing', () => {
  it('ends an oversized stream once and ignores later events without executing tools', async () => {
    const { api, emit, cancel } = fakeAiApi()
    const pending = streamOnce(api, request('bounded'), () => {})
    emit({ requestId: 'bounded', type: 'text', text: 'x'.repeat(8 * 1024 * 1024) })
    emit({ requestId: 'bounded', type: 'tool_call', call: { id: 'late', name: 'write_file', arguments: {} } })
    expect(await pending).toMatchObject({ error: expect.stringContaining('stream limit'), text: '', toolCalls: [] })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('settles a rejected backend admission instead of waiting for the stall timer', async () => {
    const { api } = fakeAiApi()
    vi.mocked(api.assistant.chat).mockRejectedValueOnce(new Error('Backend unavailable'))
    expect(await streamOnce(api, request('rejected'), () => {})).toMatchObject({ error: 'Backend unavailable', text: '', toolCalls: [] })
  })

  function fakeAiApi(): { api: ValleyPluginApi; emit: (e: AiStreamEvent) => void; cancel: ReturnType<typeof vi.fn> } {
    let handler: ((e: AiStreamEvent) => void) | null = null
    const cancel = vi.fn(async () => ({ ok: true }))
    const api = {
      assistant: {
          onStream: (cb: (e: AiStreamEvent) => void) => {
            handler = cb
            return () => {
              handler = null
            }
          },
          chat: vi.fn(async () => ({ ok: true })),
          cancel
      }
    } as unknown as ValleyPluginApi
    return { api, emit: (e) => handler?.(e), cancel }
  }

  const request = (id: string): AiChatRequest =>
    ({ requestId: id, provider: 'anthropic', model: 'claude-opus-4-8', messages: [] }) as unknown as AiChatRequest

  it('a stream that never emits resolves with a stall error and cancels the run', async () => {
    vi.useFakeTimers()
    const { api, cancel } = fakeAiApi()
    const p = streamOnce(api, request('r-stall'), () => {})
    await vi.advanceTimersByTimeAsync(180_001)
    const res = await p
    expect(res.error).toMatch(/stalled/)
    expect(cancel).toHaveBeenCalledWith('r-stall')
    vi.useRealTimers()
  })

  it('an error event resolves the turn even when the terminal done is lost', async () => {
    vi.useFakeTimers()
    const { api, emit } = fakeAiApi()
    const p = streamOnce(api, request('r-err'), () => {})
    emit({ requestId: 'r-err', type: 'error', error: 'boom' } as AiStreamEvent)
    await vi.advanceTimersByTimeAsync(1600)
    const res = await p
    expect(res.error).toBe('boom')
    vi.useRealTimers()
  })

  it('activity keeps re-arming the stall timer (a live stream never trips it)', async () => {
    vi.useFakeTimers()
    const { api, emit } = fakeAiApi()
    const p = streamOnce(api, request('r-live'), () => {})
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(100_000)
      emit({ requestId: 'r-live', type: 'text', text: 'x' } as AiStreamEvent)
    }
    emit({ requestId: 'r-live', type: 'done' } as AiStreamEvent)
    const res = await p
    expect(res.error).toBeUndefined()
    expect(res.text).toBe('xxxx')
    vi.useRealTimers()
  })
})

it('shows the provider message without its JSON envelope', () => {
  expect(friendlyStreamError('Ollama HTTP 503: {"error":{"message":"Try again.","type":"unavailable"}}')).toBe('Ollama HTTP 503: Try again.')
})

it('forwards the selected supported effort to the actual model request', async () => {
  const mock = createMockValleyApi()
  await run(mock, [{ role: 'user', content: 'Describe a fern.' }], scripted(mock, [[{ type: 'text', text: 'A fern has fronds.' }]]), {
    modelOverride: { provider: 'openai', model: 'gpt-6-sol' }, reasoningEffort: 'max'
  })
  const request = mock.driverCalls.find(call => call.driver === 'ai' && call.method === 'chat')?.payload as AiChatRequest
  expect(request).toMatchObject({ model: 'gpt-6-sol', reasoningEffort: 'max' })
})
