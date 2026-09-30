// ============================================================================
// Shared Chart.js option fragments. ValleyBarChart, ValleyFloatingBarChart and
// ValleyLineChart all build their option blocks independently; these are the
// fragments that were byte-identical across all three. Extracting them keeps a
// single source of truth without changing any rendered styling — each chart
// still assembles its own mode/scales/callbacks around these.
// ============================================================================

import type { TextColorTheme } from '../types'

/** Pointer + touch events every Notes chart listens for. */
export const CHART_EVENTS = ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove', 'touchend']

/**
 * The tooltip "chrome" (surface colors, border, padding, point style) shared by
 * every Notes chart. Spread into each chart's `tooltip` block; chart-specific
 * fields (`mode`, `boxPadding`, `titleFont`, `callbacks`, …) are added alongside.
 */
export function tooltipChrome(textColors: TextColorTheme): {
  backgroundColor: string
  titleColor: string
  bodyColor: string
  borderColor: string
  borderWidth: number
  padding: number
  usePointStyle: boolean
} {
  return {
    backgroundColor: textColors.bodyColor,
    titleColor: textColors.bodyColorText,
    bodyColor: textColors.bodyColorText,
    borderColor: textColors.lineColorRGBA,
    borderWidth: 1,
    padding: 8,
    usePointStyle: true
  }
}
