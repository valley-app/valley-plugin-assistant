import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVoiceOrb, orbFrame } from '../../src/voice/orbEngine'

afterEach(() => { vi.restoreAllMocks() })
describe('voice orb', () => {
  it('bounds particle count and uses real input/output levels', () => {
    const silent = orbFrame(72, 2, { state: 'listening', input: 0, output: 0 })
    const listening = orbFrame(72, 2, { state: 'listening', input: 0.7, output: 0 })
    const speaking = orbFrame(72, 2, { state: 'speaking', input: 0, output: 0.7 })
    expect(listening).toEqual(speaking)
    expect(listening).not.toEqual(silent)
    for (const state of ['idle', 'connecting', 'listening', 'muted', 'speaking', 'thinking', 'working', 'review', 'error'] as const) {
      const frame = orbFrame(72, 2, { state, input: NaN, output: Infinity })
      expect(frame.length).toBeLessThan(400)
      expect(frame.every(dot => Object.values(dot).every(Number.isFinite))).toBe(true)
    }
  })

  it('keeps every moving state centered and inside its fixed footprint', () => {
    for (const state of ['idle', 'connecting', 'listening', 'muted', 'speaking', 'thinking', 'working', 'review', 'error'] as const) {
      const input = { state, input: 1, output: 1 }
      expect(orbFrame(72, 0, input)).not.toEqual(orbFrame(72, 1, input))
      for (let time = 0; time < 60; time += 0.25) {
        const dots = orbFrame(72, time, input)
        expect(dots.reduce((sum, dot) => sum + dot.x, 0) / dots.length).toBeCloseTo(36, 8)
        expect(dots.reduce((sum, dot) => sum + dot.y, 0) / dots.length).toBeCloseTo(36, 8)
        expect(dots.every(dot => dot.x - dot.radius > 0 && dot.x + dot.radius < 72 && dot.y - dot.radius > 0 && dot.y + dot.radius < 72)).toBe(true)
      }
    }
  })

  it('caps DPR, throttles paint, honors motion changes and cleans every callback', () => {
    const context = { setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), globalAlpha: 1, fillStyle: '' }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
    const frames = new Map<number, FrameRequestCallback>(); let next = 0, now = 0
    vi.spyOn(window.performance, 'now').mockImplementation(() => now)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++next, callback); return next })
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(4)
    let motionListener: (() => void) | undefined
    const query = { matches: false, addEventListener: vi.fn((_type, listener) => { motionListener = listener }), removeEventListener: vi.fn() }
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => query) })
    const canvas = document.createElement('canvas'), orb = createVoiceOrb(canvas, { state: 'listening', input: 0, output: 0 })
    expect(canvas.width).toBe(144)
    context.clearRect.mockClear()
    const step = (time: number) => { now = time; const [id, callback] = frames.entries().next().value!; frames.delete(id); callback(time) }
    step(100); step(108); step(116); step(132); step(134)
    expect(context.clearRect).toHaveBeenCalledTimes(3)
    step(150)
    const count = orbFrame(72, 0, { state: 'idle', input: 0, output: 0 }).length
    const positions = context.arc.mock.calls.slice(-count)
    for (const state of ['idle', 'muted', 'review', 'error', 'thinking'] as const) {
      orb.set({ state, input: 0, output: 0 })
      expect(frames.size).toBe(1)
      expect(context.arc.mock.calls.slice(-count)).toEqual(positions)
    }
    step(250)
    expect(context.arc.mock.calls.slice(-count)).not.toEqual(positions)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(frames.size).toBe(0)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(frames.size).toBe(1)
    query.matches = true; motionListener!()
    expect(frames.size).toBe(0)
    expect(cancel).toHaveBeenCalled()
    query.matches = false; motionListener!()
    expect(frames.size).toBe(1)
    orb.destroy()
    expect(query.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    expect(frames.size).toBe(0)
  })
})
