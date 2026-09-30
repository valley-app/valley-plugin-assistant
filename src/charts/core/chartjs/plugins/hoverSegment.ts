import { Chart } from 'chart.js'

/**
 * Draws a vertical guide line at the hovered point — ported 1:1 from the reference implementation.
 * This is what makes the tooltip feel native (the "scrubber" line under it).
 */
export const hoverSegment = {
  id: 'hoverSegment',
  beforeDraw: (chart: Chart, _args: unknown, options: { value?: number; enabled?: boolean }) => {
    if (!options?.enabled) return
    const activeElements = chart.getActiveElements()
    if (!activeElements || activeElements.length === 0) return

    const { ctx, chartArea } = chart
    if (!ctx || !chartArea) return

    const firstPoint = activeElements[0]
    const x = firstPoint.element.x

    ctx.save()
    ctx.beginPath()
    ctx.moveTo(x, chartArea.top)
    ctx.lineTo(x, chartArea.bottom)
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(150, 150, 150, 0.5)'
    ctx.stroke()
    ctx.restore()
  }
}
