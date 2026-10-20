export type OrbState = 'idle' | 'connecting' | 'listening' | 'muted' | 'speaking' | 'thinking' | 'working' | 'review' | 'error'
export interface OrbInput { state: OrbState; input: number; output: number }
interface Dot { x: number; y: number; z: number; radius: number; alpha: number }

const clamp = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
const activity = (state: OrbState): number => state === 'thinking' ? 1 : state === 'working' ? 0.72 : state === 'connecting' ? 0.5 : state === 'review' ? 0.24 : 0.12

// Projection and particle arrangements adapted from the supplied Thinking Orbs engine.
function projection(yaw: number, tilt: number, size: number) {
  const st = Math.sin(tilt), ct = Math.cos(tilt), sy = Math.sin(yaw), cy = Math.cos(yaw)
  return (x: number, y: number, z: number): [number, number, number] => {
    const x1 = x * cy + z * sy, z1 = -x * sy + z * cy
    return [size / 2 + x1, size / 2 - (y * ct - z1 * st), y * st + z1 * ct]
  }
}

export function orbFrame(size: number, time: number, input: OrbInput, energy = activity(input.state)): Dot[] {
  const dots: Dot[] = [], radius = size * 0.39, level = clamp(input.state === 'speaking' ? input.output : input.input)
  const flow = clamp(energy), point = projection(time * 0.22 + flow * 0.22 * Math.sin(time * 0.8), 0.38 + 0.045 * Math.sin(time * 0.6) + flow * 0.2 * Math.sin(time * 1.1), size)
  const dot = (x: number, y: number, z: number) => {
    const [px, py, depth] = point(x, y, z), visibility = clamp((depth / radius + 1) / 2)
    dots.push({ x: px, y: py, z: depth, radius: (0.45 + visibility * 0.7) * size / 64 * (1 + level * 0.2), alpha: 0.15 + visibility * 0.8 })
  }
  for (let ring = 0; ring < 6; ring++) {
    const latitude = -Math.PI / 2 + ring / 11 * Math.PI, count = Math.max(1, Math.round(Math.cos(latitude) * 30))
    for (let index = 0; index < count; index++) {
      const angle = index / count * Math.PI * 2
      const longitude = angle + 0.07 * Math.sin(time * 0.6 + latitude * 2) + flow * (0.7 * Math.sin(latitude * 3 + time * 1.9) + 0.16 * Math.sin(angle * 2 - time * 2.7))
      const bend = latitude + flow * Math.cos(latitude) * 0.18 * Math.sin(angle * 2 + latitude * 3 + time * 2.3)
      const ripple = flow * (0.105 * Math.sin(angle * 3 + latitude * 4 - time * 2.4) + 0.045 * Math.sin(angle * 5 - latitude * 2 + time * 3.1))
      const breath = 0.018 * Math.sin(time * 1.1) + level * 0.055 * Math.sin(time * 3 - latitude * 4)
      const r = radius * (0.9 + ripple + breath), x = Math.cos(bend) * Math.cos(longitude) * r, y = Math.sin(bend) * r, z = Math.cos(bend) * Math.sin(longitude) * r
      dot(x, y, z); dot(-x, -y, -z)
    }
  }
  return dots.sort((a, b) => a.z - b.z)
}

export function createVoiceOrb(canvas: HTMLCanvasElement, initial: OrbInput, size = 72) {
  const document = canvas.ownerDocument, window = document.defaultView, context = canvas.getContext('2d')
  if (!window || !context) return { set: (_input: OrbInput) => {}, destroy: () => {} }
  const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  let input = initial, frame = 0, lastPaint = -Infinity, stopped = false, visible = true
  let energy = activity(initial.state), level = 0, elapsed = 0, lastTime: number | undefined
  const paint = (time: number) => {
    const delta = lastTime === undefined ? 0 : Math.max(0, Math.min(0.1, (time - lastTime) / 1000)), blend = 1 - Math.exp(-delta / 0.24)
    lastTime = time; elapsed += delta
    energy += (activity(input.state) - energy) * blend
    level += (clamp(input.state === 'speaking' ? input.output : input.input) - level) * blend
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (canvas.width !== Math.round(size * dpr)) { canvas.width = Math.round(size * dpr); canvas.height = Math.round(size * dpr) }
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, size, size)
    context.fillStyle = window.getComputedStyle(canvas).color
    const value = { ...input, input: motion?.matches ? 0 : level, output: motion?.matches ? 0 : level }
    for (const dot of orbFrame(size, motion?.matches ? 0.6 : elapsed, value, motion?.matches ? activity(input.state) : energy)) {
      context.globalAlpha = dot.alpha
      context.beginPath(); context.arc(dot.x, dot.y, dot.radius, 0, Math.PI * 2); context.fill()
    }
    context.globalAlpha = 1
  }
  const animated = () => !stopped && visible && document.visibilityState !== 'hidden' && !motion?.matches
  const loop = (time: number) => {
    frame = 0
    if (!animated()) { lastTime = undefined; return }
    if (time - lastPaint >= 1000 / 60 - 1) { paint(time); lastPaint = time }
    frame = window.requestAnimationFrame(loop)
  }
  const update = () => {
    if (stopped) return
    if (frame) window.cancelAnimationFrame(frame)
    frame = 0
    if (!animated()) lastTime = undefined
    if (visible && document.visibilityState !== 'hidden') paint(window.performance.now())
    if (animated()) frame = window.requestAnimationFrame(loop)
  }
  const observer = typeof window.IntersectionObserver === 'function' ? new window.IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); update() }) : null
  observer?.observe(canvas)
  document.addEventListener('visibilitychange', update)
  motion?.addEventListener('change', update)
  update()
  return {
    set(value: OrbInput) {
      const changed = input.state !== value.state
      input = { state: value.state, input: clamp(value.input), output: clamp(value.output) }
      if (changed) update()
    },
    destroy() {
      stopped = true
      if (frame) window.cancelAnimationFrame(frame)
      observer?.disconnect(); document.removeEventListener('visibilitychange', update); motion?.removeEventListener('change', update)
      context.clearRect(0, 0, size, size)
    },
  }
}
