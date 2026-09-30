import { uiText } from '../localization'
import React from 'react'
import { useRef, useMemo, memo, type FC } from 'react'
import { Line } from 'react-chartjs-2'
import { ChartJS } from './core/chartjs/registry'
import { useChartContainerResize } from './core/hooks/useChartContainerResize'
import { customNumberFormatter } from './core/formatters'
import { CHART_EVENTS, tooltipChrome } from './core/chartOptions'
import ChartShell from './core/shells/ChartShell'
import type { TextColorTheme } from './types'

export interface ValleyAreaChartProps {
  labels: string[]
  /** Single series; null where the period has no data. */
  data: (number | null)[]
  textColors: TextColorTheme
  /** Stroke colour (defaults to the app accent). */
  color?: string
  /** Low-opacity fill under the line (defaults to the accent tint). */
  fillColor?: string
  unit?: string
  /** Optional per-index tooltip titles (e.g. axis = short label, tooltip = full date). */
  tooltipTitles?: string[]
  fontSize?: number
  height?: number
  isLoading?: boolean
  changeKeyIndicator?: boolean
  noDataText?: string
  /** Hide the Y axis entirely (useful for compact sparklines where Y labels are redundant). */
  hideYAxis?: boolean
  /** Hide both axes and remove layout padding — use for edge-to-edge sparklines. */
  hideAxes?: boolean
}

/**
 * Thin, monochrome area chart for dense daily series — single accent stroke over
 * a low-opacity fill, points hidden. Reads better than ~30 tight bars and matches
 * the app's minimalist look. Shares the same tooltip/theme chrome as the bar
 * charts. Weekly/monthly (sparser) series use ValleyGroupedBarChart instead.
 */
const ValleyAreaChart: FC<ValleyAreaChartProps> = ({
  labels,
  data,
  textColors,
  color = 'var(--accent-color)',
  fillColor = 'var(--accent-tint-bg)',
  unit = '',
  tooltipTitles,
  fontSize = 12,
  height = -1,
  isLoading = false,
  changeKeyIndicator = false,
  noDataText = uiText('assistant.usage.noData'),
  hideYAxis = false,
  hideAxes = false
}) => {
  void ChartJS
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const containerChange = useChartContainerResize(chartContainerRef, changeKeyIndicator)

  const chartOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600 },
      layout: hideAxes ? { padding: 0 } : undefined,
      events: CHART_EVENTS,
      interaction: { mode: 'index' as const, intersect: false },
      plugins: {
        legend: { display: false },
        hoverSegment: { value: undefined, enabled: false },
        tooltip: {
          mode: 'index' as const,
          intersect: false,
          position: 'nearest' as const,
          ...tooltipChrome(textColors),
          boxPadding: 4,
          titleFont: { weight: 'bold' as const },
          callbacks: {

            title: (ctx: any[]) => {
              if (!ctx.length) return undefined
              return tooltipTitles?.[ctx[0].dataIndex] ?? ctx[0].label
            },

            label: (ctx: any) => {
              const value = ctx.parsed.y
              if (value === null || value === undefined) return ''
              return `${customNumberFormatter(value, '-', 2)}${unit ? ` ${unit}` : ''}`
            }
          }
        }
      },
      scales: {
        x: {
          display: !hideAxes,
          grid: { display: false },
          ticks: {
            font: { size: fontSize },
            color: textColors.titleColorRGBA,
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 8
          },
          border: { color: textColors.lineColorRGBA }
        },
        y: {
          min: 0,
          display: hideAxes ? false : !hideYAxis,
          grid: { color: textColors.lineColorRGBA },
          ticks: {
            font: { size: fontSize },
            color: textColors.titleColorRGBA,
            maxTicksLimit: 5,
            callback: (value: any) => customNumberFormatter(value, '-', 2)
          },
          border: { color: 'transparent' }
        }
      }
    }),
    [textColors, unit, fontSize, tooltipTitles, hideYAxis, hideAxes]
  )

  const chartData = useMemo(
    () => ({
      labels,
      datasets: [
        {
          type: 'line' as const,
          data,
          borderColor: color,
          backgroundColor: fillColor,
          borderWidth: 2,
          fill: true,
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: color,
          spanGaps: true
        }
      ]
    }),
    [labels, data, color, fillColor]
  )

  const hasValidData = data.some((v) => v !== null && v !== undefined)

  return (
    <ChartShell containerRef={chartContainerRef} height={height} isLoading={isLoading} hasData={hasValidData} noDataText={noDataText}>
      <div className="chart-bar">
        <Line options={chartOptions as any} data={chartData as any} key={`${containerChange}-${changeKeyIndicator}`} />
      </div>
    </ChartShell>
  )
}

export default memo(ValleyAreaChart)
