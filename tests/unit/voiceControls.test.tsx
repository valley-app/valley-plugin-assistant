import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SpeechEvent, VoiceControlAction } from '@valley/plugin-sdk/speech'
import { createMockValleyApi } from '../mock'
import { initRuntime } from '../../src/runtime'
import { VoiceControls, spokenResponse } from '../../src/voice/VoiceControls'

vi.mock('../../src/voice/VoiceOrb', () => ({ VoiceOrb: () => null }))
afterEach(cleanup)

function fixture() {
  const mock = createMockValleyApi(), listeners = new Set<(event: SpeechEvent) => void>()
  const configuration = { schemaVersion: 1, provider: 'elevenlabs', voiceId: 'voice-fern', liveMode: 'push-to-talk', replyWithVoice: true, fallbackProvider: null, includes: [] }
  const speech = {
    voices: vi.fn(async () => [{ id: 'voice-fern', name: 'Fern', provider: 'elevenlabs' }]),
    start: vi.fn(async () => ({ sessionId: 'session-a', state: 'muted' as const })),
    control: vi.fn(async (_input: { sessionId: string; action: VoiceControlAction }) => undefined), speak: vi.fn(async (): Promise<void> => {}),
    transcribe: vi.fn(), synthesize: vi.fn(),
    onEvent: vi.fn((listener: (event: SpeechEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  Object.assign(mock.api.ai, { speech })
  mock.api.backend.call = vi.fn(async (method: string, input?: unknown) => {
    if (method === 'configuration.speech.set') Object.assign(configuration, (input as { patch: object }).patch)
    return { revision: 0, values: { ...configuration } }
  }) as typeof mock.api.backend.call
  initRuntime(mock.api)
  const onTranscript = vi.fn(), onError = vi.fn(), onInterrupted = vi.fn()
  const props = { conversationId: 'chat-a', onTranscript, onError, onInterrupted }
  const emit = (event: SpeechEvent) => act(() => { for (const listener of listeners) listener(event) })
  return { ...mock, speech, props, emit, listeners, configuration }
}

async function start() { fireEvent.click(screen.getByRole('button', { name: 'Start voice' })); await screen.findByRole('button', { name: 'Hold to talk' }) }

describe('voice session lifecycle', () => {
  it('resolves empty optional provider overrides through the core defaults', async () => {
    const test = fixture()
    Object.assign(test.configuration, { connectionId: '', transcriptionConnectionId: '', synthesisModel: '', realtimeModel: '' })
    render(<VoiceControls {...test.props} />)
    await start()
    expect(test.speech.voices).toHaveBeenCalledWith({ provider: 'elevenlabs', connectionId: undefined })
    expect(test.speech.start).toHaveBeenCalledWith(expect.objectContaining({ transcription: expect.objectContaining({ connectionId: undefined, model: undefined }), synthesis: expect.objectContaining({ connectionId: undefined, model: undefined }) }))
  })

  it('starts from the sidebar request without a composer launcher, stops and can reopen', async () => {
    const test = fixture(), onClose = vi.fn()
    const view = render(<VoiceControls {...test.props} hiddenLauncher onClose={onClose} />)
    expect(screen.queryByRole('button', { name: 'Start voice' })).toBeNull()
    view.rerender(<VoiceControls {...test.props} hiddenLauncher requested onClose={onClose} />)
    await screen.findByRole('button', { name: 'Hold to talk' })
    fireEvent.click(screen.getByRole('button', { name: 'End voice' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'End voice' })).toBeNull())
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0])
    expect(onClose).toHaveBeenCalledOnce()
    view.rerender(<VoiceControls {...test.props} hiddenLauncher requested={false} onClose={onClose} />)
    view.rerender(<VoiceControls {...test.props} hiddenLauncher requested onClose={onClose} />)
    await screen.findByRole('button', { name: 'Hold to talk' })
    test.emit({ sessionId: 'session-a', conversationId: 'chat-a', type: 'transcript', utteranceId: 'reopened', text: 'Describe the meadow', final: true })
    expect(test.props.onTranscript).toHaveBeenCalledWith({ id: 'reopened', text: 'Describe the meadow' })
    await act(async () => { await Promise.resolve() })
  })

  it('subscribes before starting, sends PTT controls in order and only commits each final transcript once', async () => {
    const test = fixture()
    render(<VoiceControls {...test.props} />)
    await start()
    expect(test.speech.onEvent.mock.invocationCallOrder[0]).toBeLessThan(test.speech.start.mock.invocationCallOrder[0])
    expect(test.speech.start).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'chat-a', mode: 'push-to-talk', synthesis: expect.objectContaining({ provider: 'elevenlabs', voice: 'voice-fern' }) }))
    const hold = screen.getByRole('button', { name: 'Hold to talk' })
    fireEvent.keyDown(hold, { key: ' ' }); fireEvent.keyUp(hold, { key: ' ' })
    await waitFor(() => expect(test.speech.control.mock.calls.map(([value]) => value.action)).toEqual(['unmute', 'commit', 'mute']))
    const event = { sessionId: 'session-a', conversationId: 'chat-a', type: 'transcript' as const, utteranceId: 'utterance-a', text: 'Describe the forest', final: false }
    test.emit(event)
    expect(test.props.onTranscript).not.toHaveBeenCalled()
    test.emit({ ...event, final: true }); test.emit({ ...event, final: true })
    test.emit({ ...event, sessionId: 'other', utteranceId: 'other', final: true })
    expect(test.props.onTranscript).toHaveBeenCalledOnce()
    expect(test.props.onTranscript).toHaveBeenCalledWith({ id: 'utterance-a', text: 'Describe the forest' })
    await act(async () => { await Promise.resolve() })
  })

  it('stops the session and unsubscribes on conversation change or unmount', async () => {
    const test = fixture(), view = render(<VoiceControls {...test.props} />)
    await start()
    view.rerender(<VoiceControls {...test.props} conversationId="chat-b" />)
    await waitFor(() => expect(test.speech.control).toHaveBeenCalledWith({ sessionId: 'session-a', action: 'stop' }))
    expect(test.listeners.size).toBe(1)
    view.unmount()
    expect(test.listeners.size).toBe(0)
  })

  it('stops a late connection after the component leaves', async () => {
    const test = fixture()
    let resolve!: (session: { sessionId: string; state: 'muted' }) => void
    test.speech.start.mockImplementation(() => new Promise(value => { resolve = value }))
    const view = render(<VoiceControls {...test.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }))
    await waitFor(() => expect(test.speech.start).toHaveBeenCalledOnce())
    view.unmount()
    await act(async () => { resolve({ sessionId: 'late', state: 'muted' }); await Promise.resolve() })
    expect(test.speech.control).toHaveBeenCalledWith({ sessionId: 'late', action: 'stop' })
  })

  it('requires a catalog voice instead of inventing one', async () => {
    const test = fixture()
    test.configuration.voiceId = ''
    render(<VoiceControls {...test.props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }))
    const picker = await screen.findByRole('combobox', { name: 'Choose voice' })
    expect(test.speech.start).not.toHaveBeenCalled()
    fireEvent.change(picker, { target: { value: 'voice-fern' } })
    await waitFor(() => expect(test.api.backend.call).toHaveBeenCalledWith('configuration.speech.set', { patch: { voiceId: 'voice-fern' }, expectedRevision: 0 }))
  })

  it('speaks only new response IDs and routes interruption once', async () => {
    const test = fixture(), view = render(<VoiceControls {...test.props} response={{ id: 'old', text: 'Old history' }} />)
    await start()
    expect(test.speech.speak).not.toHaveBeenCalled()
    view.rerender(<VoiceControls {...test.props} response={{ id: 'new', text: '**Forest** habitats' }} />)
    await waitFor(() => expect(test.speech.speak).toHaveBeenCalledWith({ sessionId: 'session-a', generationId: 'new:0', text: 'Forest habitats' }))
    view.rerender(<VoiceControls {...test.props} response={{ id: 'new', text: '**Forest** habitats' }} />)
    expect(test.speech.speak).toHaveBeenCalledOnce()
    const event = { sessionId: 'session-a', conversationId: 'chat-a', type: 'interrupted' as const, generationId: 'new:0' }
    test.emit(event); test.emit(event)
    expect(test.props.onInterrupted).toHaveBeenCalledOnce()
  })

  it.each(['idle', 'failed'] as const)('completes a silent %s turn without closing the microphone session', async executionState => {
    const test = fixture(), view = render(<VoiceControls {...test.props} executionState="thinking" />)
    test.configuration.replyWithVoice = false
    await start()
    test.emit({ sessionId: 'session-a', conversationId: 'chat-a', type: 'transcript', utteranceId: 'utterance-a', text: 'Describe the forest', final: true })
    await act(async () => { await Promise.resolve() })
    expect(test.speech.control).not.toHaveBeenCalled()
    view.rerender(<VoiceControls {...test.props} executionState={executionState} response={{ id: 'answer', text: 'Forest habitats' }} />)
    await waitFor(() => expect(test.speech.control).toHaveBeenCalledWith({ sessionId: 'session-a', action: 'processing-complete', utteranceId: 'utterance-a' }))
    expect(test.speech.speak).not.toHaveBeenCalled()
    expect(test.speech.control.mock.calls.some(([value]) => value.action === 'stop')).toBe(false)
    expect(screen.getByRole('button', { name: 'Hold to talk' })).toBeTruthy()
  })

  it('holds processing through every spoken chunk and completes the captured utterance after playback settles', async () => {
    const test = fixture(), finishes: Array<() => void> = []
    test.speech.speak.mockImplementation(() => new Promise<void>(resolve => finishes.push(resolve)))
    const view = render(<VoiceControls {...test.props} executionState="thinking" />)
    await start()
    test.emit({ sessionId: 'session-a', conversationId: 'chat-a', type: 'transcript', utteranceId: 'utterance-a', text: 'Describe the forest', final: true })
    await act(async () => { await Promise.resolve() })
    view.rerender(<VoiceControls {...test.props} executionState="completed" response={{ id: 'answer', text: 'a'.repeat(5000) }} />)
    await waitFor(() => expect(test.speech.speak).toHaveBeenCalledTimes(1))
    expect(test.speech.control).not.toHaveBeenCalled()
    await act(async () => { finishes[0]() })
    expect(test.speech.speak).toHaveBeenCalledTimes(2)
    expect(test.speech.control).not.toHaveBeenCalled()
    await act(async () => { finishes[1]() })
    expect(test.speech.control).toHaveBeenCalledOnce()
    expect(test.speech.control).toHaveBeenCalledWith({ sessionId: 'session-a', action: 'processing-complete', utteranceId: 'utterance-a' })
  })

  it('cancels processing and queued output while keeping the session, and ignores late output completion', async () => {
    const test = fixture()
    let finish!: () => void
    test.speech.speak.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    const view = render(<VoiceControls {...test.props} executionState="thinking" />)
    await start()
    test.emit({ sessionId: 'session-a', conversationId: 'chat-a', type: 'transcript', utteranceId: 'utterance-a', text: 'Describe the forest', final: true })
    await act(async () => { await Promise.resolve() })
    view.rerender(<VoiceControls {...test.props} executionState="completed" response={{ id: 'answer', text: 'a'.repeat(5000) }} />)
    await waitFor(() => expect(test.speech.speak).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }))
    await waitFor(() => expect(test.speech.control).toHaveBeenCalledWith({ sessionId: 'session-a', action: 'cancel' }))
    test.emit({ sessionId: 'session-a', conversationId: 'chat-a', type: 'interrupted', generationId: 'answer:0' })
    expect(test.props.onInterrupted).toHaveBeenCalledOnce()
    view.rerender(<VoiceControls {...test.props} executionState="thinking" />)
    test.emit({ sessionId: 'session-a', conversationId: 'chat-a', type: 'transcript', utteranceId: 'utterance-b', text: 'Something else', final: true })
    await act(async () => { finish() })
    expect(test.speech.speak).toHaveBeenCalledOnce()
    expect(test.speech.control.mock.calls.some(([value]) => value.action === 'processing-complete' || value.action === 'stop')).toBe(false)
    expect(screen.getByRole('button', { name: 'Hold to talk' })).toBeTruthy()
    view.rerender(<VoiceControls {...test.props} executionState="cancelled" />)
    await waitFor(() => expect(test.speech.control.mock.calls.filter(([value]) => value.action === 'cancel')).toHaveLength(2))
  })

  it('releases processing when submitting a final transcript fails', async () => {
    const test = fixture()
    test.props.onTranscript.mockRejectedValue(new Error('Submit failed'))
    render(<VoiceControls {...test.props} executionState="thinking" />)
    await start()
    test.emit({ sessionId: 'session-a', conversationId: 'chat-a', type: 'transcript', utteranceId: 'utterance-a', text: 'Describe the forest', final: true })
    await waitFor(() => expect(test.speech.control).toHaveBeenCalledWith({ sessionId: 'session-a', action: 'processing-complete', utteranceId: 'utterance-a' }))
    expect(test.props.onError).toHaveBeenCalledWith('Submit failed')
  })

  it('converts display markup for speech without reading code fences or URLs', () => {
    expect(spokenResponse('# Forest\n[Leaf](https://example.org) [[Tree|Oak]]\n```js\nsecret()\n```')).toBe('Forest\nLeaf Oak')
  })
})
