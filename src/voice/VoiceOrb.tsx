import { React } from '../runtime'
import { createVoiceOrb, type OrbInput } from './orbEngine'

export function VoiceOrb({ size = 72, ...input }: OrbInput & { size?: number }) {
  const canvas = React.useRef<HTMLCanvasElement>(null), orb = React.useRef<ReturnType<typeof createVoiceOrb>>()
  React.useEffect(() => {
    if (!canvas.current) return
    orb.current = createVoiceOrb(canvas.current, input, size)
    return () => { orb.current?.destroy(); orb.current = undefined }
  }, [])
  React.useEffect(() => { orb.current?.set(input) }, [input.state, input.input, input.output])
  return <canvas ref={canvas} className="assistant-voice-orb" data-state={input.state} data-error={input.state === 'error' || undefined} width={size} height={size} style={{ width: size, height: size, flexBasis: size }} aria-hidden="true" />
}
