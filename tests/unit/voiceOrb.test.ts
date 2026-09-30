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
    for (const state of ['idle', 'connecting', 'listening', 'speaking', 'thinking', 'working', 'review', 'error'] as const) {
      const frame = orbFrame(72, 2, { state, input: NaN, output: Infinity })
      expect(frame.length).toBeLessThan(400)
      expect(frame.every(dot => Object.values(dot).every(Number.isFinite))).toBe(true)
    }
  })

  it('caps DPR, throttles paint, honors motion changes and cleans every callback', () => {
    const context = { setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), globalAlpha: 1, fillStyle: '' }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
    const frames = new Map<number, FrameRequestCallback>(); let next = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++next, callback); return next })
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(4)
    let motionListener: (() => void) | undefined
    const query = { matches: false, addEventListener: vi.fn((_type, listener) => { motionListener = listener }), removeEventListener: vi.fn() }
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => query) })
    const canvas = document.createElement('canvas'), orb = createVoiceOrb(canvas, { state: 'listening', input: 0, output: 0 })
    expect(canvas.width).toBe(144)
    context.clearRect.mockClear()
    const step = (time: number) => { const [id, callback] = frames.entries().next().value!; frames.delete(id); callback(time) }
    step(100); step(116); step(132); step(134)
    expect(context.clearRect).toHaveBeenCalledTimes(2)
    query.matches = true; motionListener!()
    expect(frames.size).toBe(0)
    expect(cancel).toHaveBeenCalled()
    orb.destroy()
    expect(query.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    expect(frames.size).toBe(0)
  })
})
