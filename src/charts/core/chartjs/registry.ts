/**
 * Centralised Chart.js registration — ported 1:1 from the reference implementation. Single point
 * that registers every scale/element/controller/plugin the app uses. Idempotent.
 */
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarController,
  BarElement,
  PointElement,
  LineElement,
  LineController,
  DoughnutController,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js'

import { hoverSegment } from './plugins/hoverSegment'
import { tickerGroupSpacing } from './plugins/tickerGroupSpacing'

let isRegistered = false

export function registerChartComponents(): void {
  if (isRegistered) return
  ChartJS.register(
    CategoryScale,
    LinearScale,
    BarElement,
    PointElement,
    LineElement,
    ArcElement,
    BarController,
    LineController,
    DoughnutController,
    Title,
    Tooltip,
    Legend,
    Filler,
    hoverSegment,
    tickerGroupSpacing
  )
  isRegistered = true
}

registerChartComponents()

export { ChartJS }
export { hoverSegment }
