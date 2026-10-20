import type { SpeechEvent, VoiceState, SpeechVoice } from '@valley/plugin-sdk/speech'
import type { SpeechSettings } from '../backend/configuration/schemas'
import { React, api } from '../runtime'
import { uiText } from '../localization'
import { ErrorNotice } from '../Preferences'
import { VoiceOrb } from './VoiceOrb'
import type { OrbState } from './orbEngine'
import css from './voice.css'

export interface VoiceControlsProps {
  hiddenLauncher?: boolean
  requested?: boolean
  onClose?(): void
  conversationId: string
  executionState?: 'idle' | 'queued' | 'running' | 'thinking' | 'working' | 'review' | 'failed' | 'cancelled' | 'completed'
  response?: { id: string; text: string }
  onTranscript(value: { id: string; text: string }): void | Promise<void>
  onError(error: string): void
  onInterrupted?(): void
}
const Button: typeof api.ui.settings.Button = props => React.createElement(api.ui.settings.Button, props)
const words = (key: string) => uiText(`assistant.voice.${key}`)
export function spokenResponse(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_all, path: string, label?: string) => label ?? path).replace(/^#{1,6}\s+/gm, '').replace(/[*_`~]/g, '').trim()
}

export function VoiceControls(props: VoiceControlsProps) {
  const [open, setOpen] = React.useState(false), [state, setState] = React.useState<VoiceState>('stopped')
  const [sessionId, setSessionId] = React.useState<string>(), [settings, setSettings] = React.useState<SpeechSettings & { configurationRevision: number }>()
  const [voices, setVoices] = React.useState<SpeechVoice[]>([]), [choosing, setChoosing] = React.useState(false)
  const [error, setError] = React.useState(''), [transcript, setTranscript] = React.useState(''), [holding, setHolding] = React.useState(false)
  const [levels, setLevels] = React.useState({ input: 0, output: 0 })
  const session = React.useRef<string>(), launchEpoch = React.useRef(0), epoch = React.useRef(0), pending = React.useRef(false), held = React.useRef(false)
  const callbacks = React.useRef(props), seen = React.useRef(new Set<string>()), interrupted = React.useRef(new Set<string>())
  const lastResponse = React.useRef<string>(), speechEpoch = React.useRef(0), controls = React.useRef(Promise.resolve())
  const processing = React.useRef<{ utteranceId: string; sessionId: string; epoch: number; submitted: boolean }>(), speaking = React.useRef<string>()
  const [turnRevision, setTurnRevision] = React.useState(0)
  callbacks.current = props
  const fail = (value: unknown) => { const message = value instanceof Error ? value.message : String(value); setError(message); callbacks.current.onError(message) }
  const completeProcessing = async (turn: typeof processing.current) => {
    if (!turn || processing.current !== turn || turn.epoch !== epoch.current || turn.sessionId !== session.current) return
    processing.current = undefined
    try { await api.ai.speech.control({ sessionId: turn.sessionId, action: 'processing-complete', utteranceId: turn.utteranceId }) }
    catch (error) { if (turn.epoch === epoch.current) fail(error) }
  }

  React.useEffect(() => {
    const myEpoch = ++epoch.current
    setState('stopped'); setSessionId(undefined); setOpen(false); setHolding(false); setTranscript(''); setError(''); setLevels({ input: 0, output: 0 })
    seen.current.clear(); interrupted.current.clear(); held.current = false; pending.current = false; processing.current = undefined; speaking.current = undefined
    if (!api.ai.speech) return
    const off = api.ai.speech.onEvent((event: SpeechEvent) => {
      if (myEpoch !== epoch.current || event.conversationId !== props.conversationId || event.sessionId !== session.current) return
      if (event.type === 'state') {
        setState(event.state)
        if (event.state === 'stopped') { session.current = undefined; processing.current = undefined; setSessionId(undefined); held.current = false; setHolding(false); speechEpoch.current++ }
      } else if (event.type === 'level') setLevels({ input: event.input, output: event.output })
      else if (event.type === 'error') fail(event.error)
      else if (event.type === 'transcript') {
        setTranscript(event.text)
        if (event.final && event.text.trim() && !seen.current.has(event.utteranceId)) {
          seen.current.add(event.utteranceId)
          if (seen.current.size > 256) seen.current.delete(seen.current.values().next().value!)
          const turn = { utteranceId: event.utteranceId, sessionId: event.sessionId, epoch: myEpoch, submitted: false }
          processing.current = turn; speaking.current = undefined; speechEpoch.current++
          try {
            void Promise.resolve(callbacks.current.onTranscript({ id: event.utteranceId, text: event.text.trim() })).then(() => {
              if (processing.current === turn && myEpoch === epoch.current) { turn.submitted = true; setTurnRevision(value => value + 1) }
            }).catch(error => { if (processing.current === turn && myEpoch === epoch.current) { fail(error); void completeProcessing(turn) } })
          } catch (error) { fail(error); void completeProcessing(turn) }
        }
      } else if (event.type === 'interrupted' && !interrupted.current.has(event.generationId)) {
        interrupted.current.add(event.generationId)
        speechEpoch.current++; processing.current = undefined; speaking.current = undefined
        callbacks.current.onInterrupted?.()
      }
    })
    return () => {
      epoch.current++; speechEpoch.current++; processing.current = undefined; off()
      const id = session.current; session.current = undefined; held.current = false
      if (id) void api.ai.speech.control({ sessionId: id, action: 'stop' }).catch(() => undefined)
    }
  }, [props.conversationId])

  const load = async () => {
    if (!api.ai.speech) throw new Error(words('unavailable'))
    const document = await api.backend.call<{ revision: number; values: SpeechSettings }>('configuration.speech')
    const configuration = { ...document.values, configurationRevision: document.revision }
    const available = await api.ai.speech.voices({ provider: configuration.provider, connectionId: configuration.connectionId || undefined })
    return { configuration, available }
  }
  const start = async () => {
    if (pending.current || session.current) return
    const myEpoch = epoch.current, attempt = ++launchEpoch.current
    pending.current = true; setOpen(true); setState('connecting'); setError('')
    try {
      const { configuration, available } = await load()
      if (myEpoch !== epoch.current || attempt !== launchEpoch.current) return
      setSettings(configuration); setVoices(available)
      if (!configuration.voiceId || !available.some(voice => voice.id === configuration.voiceId)) { setChoosing(true); setState('stopped'); return }
      lastResponse.current = callbacks.current.response?.id
      const started = await api.ai.speech.start({
        conversationId: props.conversationId,
        transcription: { provider: configuration.transcriptionProvider ?? configuration.provider, connectionId: configuration.transcriptionConnectionId || (!configuration.transcriptionProvider || configuration.transcriptionProvider === configuration.provider ? configuration.connectionId || undefined : undefined), model: configuration.realtimeModel || undefined },
        synthesis: { provider: configuration.provider, connectionId: configuration.connectionId || undefined, model: configuration.synthesisModel || undefined, voice: configuration.voiceId },
        mode: configuration.liveMode,
      })
      if (myEpoch !== epoch.current || attempt !== launchEpoch.current) { await api.ai.speech.control({ sessionId: started.sessionId, action: 'stop' }); return }
      session.current = started.sessionId; setSessionId(started.sessionId); setState(started.state); setChoosing(false)
    } catch (error) { if (myEpoch === epoch.current && attempt === launchEpoch.current) { setState('stopped'); fail(error) } }
    finally { if (myEpoch === epoch.current && attempt === launchEpoch.current) pending.current = false }
  }
  const stop = async () => {
    const id = session.current
    session.current = undefined; processing.current = undefined; speechEpoch.current++; setSessionId(undefined); setState('stopped'); setHolding(false); setLevels({ input: 0, output: 0 }); held.current = false
    if (id) try { await api.ai.speech.control({ sessionId: id, action: 'stop' }) } catch (error) { fail(error) }
  }
  const control = (action: 'mute' | 'unmute' | 'commit' | 'cancel') => {
    const id = session.current, myEpoch = epoch.current
    if (!id) return
    controls.current = controls.current.catch(() => undefined).then(async () => {
      if (myEpoch === epoch.current && session.current === id) await api.ai.speech.control({ sessionId: id, action })
    }).catch(error => { if (myEpoch === epoch.current) fail(error) })
  }
  const cancel = () => {
    speechEpoch.current++; processing.current = undefined
    if (speaking.current) interrupted.current.add(speaking.current)
    speaking.current = undefined
    control('cancel')
  }
  const begin = () => { if (!session.current || held.current) return; held.current = true; setHolding(true); control('unmute') }
  const finish = () => { if (!held.current) return; held.current = false; setHolding(false); control('commit'); control('mute') }
  const selectVoice = async (id: string) => {
    if (!settings || session.current || !voices.some(voice => voice.id === id)) return
    try { const saved = await api.backend.call<{ revision: number; values: SpeechSettings }>('configuration.speech.set', { patch: { voiceId: id }, expectedRevision: settings.configurationRevision }); setSettings({ ...saved.values, configurationRevision: saved.revision }); setError('') } catch (error) { fail(error) }
  }
  const choose = async () => {
    const myEpoch = epoch.current
    setOpen(true); setChoosing(true); setError('')
    try { const { configuration, available } = await load(); if (myEpoch === epoch.current) { setSettings(configuration); setVoices(available) } } catch (error) { if (myEpoch === epoch.current) fail(error) }
  }

  React.useEffect(() => {
    const response = props.response, id = session.current
    if (!id) return
    if (props.executionState === 'cancelled') { cancel(); return }
    const busy = ['queued', 'running', 'thinking', 'working'].includes(props.executionState ?? '')
    if (busy) return
    const turn = processing.current
    if (turn && !turn.submitted) return
    if (!response || response.id === lastResponse.current || props.executionState === 'failed') {
      if (!speaking.current) void completeProcessing(turn)
      return
    }
    lastResponse.current = response.id
    const myEpoch = epoch.current, currentSpeech = ++speechEpoch.current, text = settings?.replyWithVoice === false ? '' : spokenResponse(response.text)
    void (async () => {
      try {
        for (let offset = 0; offset < text.length; offset += 4096) {
          if (myEpoch !== epoch.current || currentSpeech !== speechEpoch.current || session.current !== id) return
          speaking.current = `${response.id}:${offset / 4096}`
          await api.ai.speech.speak({ sessionId: id, generationId: speaking.current, text: text.slice(offset, offset + 4096) })
        }
      } catch (error) { if (myEpoch === epoch.current && currentSpeech === speechEpoch.current) fail(error) }
      finally {
        if (myEpoch === epoch.current && currentSpeech === speechEpoch.current && session.current === id) { speaking.current = undefined; await completeProcessing(turn) }
      }
    })()
  }, [props.response?.id, props.response?.text, props.executionState, sessionId, settings?.replyWithVoice, turnRevision])

  React.useEffect(() => {
    if (props.requested) void start()
  }, [props.requested, props.conversationId])
  const close = () => { launchEpoch.current++; pending.current = false; void stop(); setOpen(false); props.onClose?.() }

  const executing = props.executionState === 'running' || props.executionState === 'thinking' || props.executionState === 'queued'
  const orb: OrbState = error ? 'error' : state === 'speaking' ? 'speaking' : props.executionState === 'review' ? 'review' : props.executionState === 'working' ? 'working' : executing || state === 'processing' ? 'thinking' : state === 'stopped' ? 'idle' : state
  const status = error ? words('error') : words(orb)
  if (!open) return props.hiddenLauncher ? null : <div className="assistant-voice-entry"><style>{css}</style><Button size="small" variant="ghost" onClick={() => void start()}>{words('start')}</Button></div>
  const actions = <div className="assistant-voice-actions">
    {!sessionId && <Button size="small" disabled={state === 'connecting'} onClick={() => void start()}>{words('start')}</Button>}
    {sessionId && settings?.liveMode === 'push-to-talk' && <Button size="small" className="assistant-voice-hold" aria-pressed={holding} onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId); begin() }} onPointerUp={finish} onPointerCancel={finish} onBlur={finish} onKeyDown={event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); begin() } }} onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); finish() } }}>{words('hold')}</Button>}
    {sessionId && settings?.liveMode === 'hands-free' && <Button size="small" onClick={() => control(state === 'muted' ? 'unmute' : 'mute')}>{words(state === 'muted' ? 'unmute' : 'mute')}</Button>}
    {sessionId && <Button size="small" variant="ghost" onClick={() => { cancel(); callbacks.current.onInterrupted?.() }}>{words('interrupt')}</Button>}
    {sessionId ? <Button size="small" variant="ghost" onClick={() => void stop()}>{words('stop')}</Button> : <Button size="small" variant="ghost" disabled={state === 'connecting'} onClick={close}>{words('close')}</Button>}
    {!sessionId && <Button size="small" variant="ghost" disabled={state === 'connecting'} onClick={() => void choose()}>{words('choose')}</Button>}
    <Button size="small" variant="ghost" onClick={() => api.workspace.openSettings('plugin:assistant#voice')}>{words('settings')}</Button>
  </div>
  const select = choosing && !sessionId && <div className="assistant-voice-select"><api.ui.settings.SelectField value={settings?.voiceId ?? ''} ariaLabel={words('choose')} options={[{ value: '', label: words('choose') }, ...voices.map(voice => ({ value: voice.id, label: voice.name }))]} onChange={value => void selectVoice(value)} />{!voices.length && <span>{words('noVoices')}</span>}</div>
  if (props.hiddenLauncher) {
    // Started from the sidebar: the voice conversation takes over the whole chat page, with the orb in the centre.
    return <section className="assistant-voice-page" role="dialog" aria-modal="true" aria-label={words('heading')} onKeyDown={event => { if (event.key === 'Escape') close() }}>
      <style>{css}</style>
      <VoiceOrb state={orb} input={levels.input} output={levels.output} size={240} />
      <span className="assistant-voice-status" role="status" aria-live="polite">{status}</span>
      {transcript && <p className="assistant-voice-transcript">{transcript}</p>}
      {actions}
      {select}
      {error && <ErrorNotice error={error} />}
    </section>
  }
  const panel = <section className="assistant-voice-panel" aria-label={words('heading')}>
    <style>{css}</style><VoiceOrb state={orb} input={levels.input} output={levels.output} />
    <div className="assistant-voice-content"><span className="assistant-voice-status" role="status" aria-live="polite">{status}</span>{transcript && <p className="assistant-voice-transcript">{transcript}</p>}
      {actions}
    </div>
    {select}
    {error && <ErrorNotice error={error} />}
  </section>
  return panel
}
