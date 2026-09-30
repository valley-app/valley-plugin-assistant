import { React } from '../runtime'
import { createVoiceOrb, type OrbInput } from './orbEngine'

export function VoiceOrb(input: OrbInput) {
  const canvas = React.useRef<HTMLCanvasElement>(null), orb = React.useRef<ReturnType<typeof createVoiceOrb>>()
  React.useEffect(() => {
    if (!canvas.current) return
    orb.current = createVoiceOrb(canvas.current, input)
    return () => { orb.current?.destroy(); orb.current = undefined }
  }, [])
  React.useEffect(() => { orb.current?.set(input) }, [input.state, input.input, input.output])
  return <canvas ref={canvas} className="assistant-voice-orb" width={72} height={72} aria-hidden="true" />
}
