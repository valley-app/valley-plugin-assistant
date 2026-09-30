export type OrbState = 'idle' | 'connecting' | 'listening' | 'muted' | 'speaking' | 'thinking' | 'working' | 'review' | 'error'
export interface OrbInput { state: OrbState; input: number; output: number }
interface Dot { x: number; y: number; z: number; radius: number; alpha: number }

const clamp = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
const hash = (a: number, b: number): number => { const value = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return value - Math.floor(value) }

// Projection and particle arrangements adapted from the supplied Thinking Orbs engine.
function projection(yaw: number, tilt: number, size: number) {
  const st = Math.sin(tilt), ct = Math.cos(tilt), sy = Math.sin(yaw), cy = Math.cos(yaw)
  return (x: number, y: number, z: number): [number, number, number] => {
    const x1 = x * cy + z * sy, z1 = -x * sy + z * cy
    return [size / 2 + x1, size / 2 - (y * ct - z1 * st), y * st + z1 * ct]
  }
}

export function orbFrame(size: number, time: number, input: OrbInput): Dot[] {
  const dots: Dot[] = [], radius = size * 0.39, level = clamp(input.state === 'speaking' ? input.output : input.input)
  const point = projection(time * 0.18, 0.38, size)
  const dot = (x: number, y: number, z: number, weight = 1) => {
    const [px, py, depth] = point(x, y, z), visibility = clamp((depth / radius + 1) / 2)
    dots.push({ x: px, y: py, z: depth, radius: (0.45 + visibility * 0.7) * size / 64 * weight, alpha: 0.15 + visibility * 0.8 })
  }
  if (input.state === 'working' || input.state === 'connecting') {
    for (let orbit = 0; orbit < 7; orbit++) {
      const angle = hash(orbit, 1.7) * Math.PI * 2, pitch = Math.acos(2 * hash(orbit, 5.2) - 1), r = radius * (0.5 + 0.5 * hash(orbit, 8.9))
      const ux = Math.cos(angle), uy = Math.sin(angle), vx = -uy * Math.cos(pitch), vy = ux * Math.cos(pitch), vz = Math.sin(pitch)
      for (let index = 0; index < 24; index++) {
        const phase = index / 24 * Math.PI * 2 + time * (0.3 + hash(orbit, 3)), c = Math.cos(phase), s = Math.sin(phase)
        dot((ux * c + vx * s) * r, (uy * c + vy * s) * r, vz * s * r, index % 8 === 0 ? 1.6 : 0.65)
      }
    }
  } else if (input.state === 'thinking' || input.state === 'review') {
    for (let lane = 0; lane < 5; lane++) for (let index = 0; index < 48; index++) {
      const angle = index / 48 * Math.PI * 2, wobble = 0.16 * Math.sin(angle * 3 - time * 1.7 + lane * 0.22) + 0.07 * Math.sin(angle * 5 + time * 1.1)
      const off = (lane - 2) * 0.075 + wobble, normal = Math.sqrt(1 + off * off)
      dot(Math.cos(angle) / normal * radius, Math.sin(angle) / normal * radius * 0.5 + off * radius, Math.sin(angle) / normal * radius * 0.75)
    }
  } else {
    for (let ring = 0; ring <= 11; ring++) {
      const latitude = -Math.PI / 2 + ring / 11 * Math.PI, cosine = Math.cos(latitude), sine = Math.sin(latitude)
      const wave = level * (0.62 * Math.sin(time * 2.1 - ring * 0.52) + 0.38 * Math.sin(time * 1.27 + ring * 0.83))
      const r = radius * (0.9 + wave * 0.1), count = Math.max(1, Math.round(Math.abs(cosine) * 30))
      for (let index = 0; index < count; index++) { const longitude = index / count * Math.PI * 2; dot(cosine * Math.cos(longitude) * r, sine * r, cosine * Math.sin(longitude) * r, 1 + level * 0.3) }
    }
  }
  return dots.sort((a, b) => a.z - b.z)
}

export function createVoiceOrb(canvas: HTMLCanvasElement, initial: OrbInput) {
  const document = canvas.ownerDocument, window = document.defaultView, context = canvas.getContext('2d')
  if (!window || !context) return { set: (_input: OrbInput) => {}, destroy: () => {} }
  const size = 72, motion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  let input = initial, frame = 0, lastPaint = -Infinity, stopped = false, visible = true
  const paint = (time: number) => {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (canvas.width !== Math.round(size * dpr)) { canvas.width = Math.round(size * dpr); canvas.height = Math.round(size * dpr) }
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, size, size)
    context.fillStyle = window.getComputedStyle(canvas).color
    const value = motion?.matches ? { ...input, input: 0, output: 0 } : input
    for (const dot of orbFrame(size, motion?.matches ? 0.6 : time / 1000, value)) {
      context.globalAlpha = dot.alpha
      context.beginPath(); context.arc(dot.x, dot.y, dot.radius, 0, Math.PI * 2); context.fill()
    }
    context.globalAlpha = 1
  }
  const animated = () => !stopped && visible && document.visibilityState !== 'hidden' && !motion?.matches && input.state !== 'idle' && input.state !== 'muted' && input.state !== 'error' && input.state !== 'review'
  const loop = (time: number) => {
    frame = 0
    if (!animated()) return
    if (time - lastPaint >= 1000 / 30) { paint(time); lastPaint = time }
    frame = window.requestAnimationFrame(loop)
  }
  const update = () => {
    if (stopped) return
    if (frame) window.cancelAnimationFrame(frame)
    frame = 0
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
