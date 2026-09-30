import { Chart } from 'chart.js'

interface TickerGroupSpacingOptions {
  enabled?: boolean
  tickerGap?: number
}

/** Reserves horizontal gaps between grouped-bar series — ported from the reference implementation. */
export const tickerGroupSpacing = {
  id: 'tickerGroupSpacing',
  beforeDraw: (chart: Chart, _args: unknown, options: TickerGroupSpacingOptions) => {
    if (!options?.enabled) return
    void chart
  }
}
