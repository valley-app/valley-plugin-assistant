import { uiText } from '../localization'
import React from 'react'
import { useRef, useMemo, memo, type FC } from 'react'
import { Bar } from 'react-chartjs-2'
import { ChartJS } from './core/chartjs/registry'
import { useChartContainerResize } from './core/hooks/useChartContainerResize'
import { customNumberFormatter } from './core/formatters'
import { CHART_EVENTS, tooltipChrome } from './core/chartOptions'
import ChartShell from './core/shells/ChartShell'
import type { TextColorTheme } from './types'

export interface GroupedSeries {
  label: string
  /** One value per label index (null where the category isn't in this series). */
  data: (number | null)[]
  color: string
}

export interface ValleyGroupedBarChartProps {
  labels: string[]
  series: GroupedSeries[]
  textColors: TextColorTheme
  /** Optional per-index tooltip titles; when set, the hover shows these
   *  instead of the axis label (e.g. axis = date, tooltip = name). */
  tooltipTitles?: string[]
  unit?: string
  /** Optional fixed y-axis range, e.g. [1, 6] for Swiss grades. */
  yRange?: [number, number]
  /** Stack the series instead of grouping them side by side. */
  stacked?: boolean
  /** Hide the legend (single-series usage). */
  legend?: boolean
  fontSize?: number
  height?: number
  isLoading?: boolean
  changeKeyIndicator?: boolean
  noDataText?: string
  onSelect?: (index: number, datasetIndex: number) => void
}

/**
 * Multi-dataset categorical bar chart. Same tooltip/theme chrome as
 * ValleyBarChart, but renders one dataset per series (with a legend) so a
 * single category can be coloured by which conditional series it falls into.
 */
const ValleyGroupedBarChart: FC<ValleyGroupedBarChartProps> = ({
  labels,
  series,
  textColors,
  tooltipTitles,
  unit = '',
  yRange,
  stacked = false,
  legend = true,
  fontSize = 12,
  height = -1,
  isLoading = false,
  changeKeyIndicator = false,
  noDataText = uiText('assistant.usage.noData'),
  onSelect
}) => {
  void ChartJS
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const containerChange = useChartContainerResize(chartContainerRef, changeKeyIndicator)

  const chartOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 750 },
      events: CHART_EVENTS,
      interaction: { mode: 'nearest' as const, intersect: false },
      onClick: (_event: unknown, elements: { index: number; datasetIndex: number }[]) => {
        const hit = elements[0]
        if (hit) onSelect?.(hit.index, hit.datasetIndex)
      },
      plugins: {
        legend: {
          display: legend,
          position: 'top' as const,
          labels: {
            color: textColors.titleColorRGBA,
            usePointStyle: true,
            boxWidth: 8,
            font: { size: fontSize }
          }
        },
        hoverSegment: { value: undefined, enabled: false },
        tooltip: {
          mode: 'nearest' as const,
          intersect: false,
          position: 'nearest' as const,
          ...tooltipChrome(textColors),
          boxPadding: 4,
          titleFont: { weight: 'bold' as const },
          callbacks: {

            title: (ctx: any[]) => {
              if (!tooltipTitles || !ctx.length) return undefined
              return tooltipTitles[ctx[0].dataIndex] ?? ctx[0].label
            },

            label: (ctx: any) => {
              const value = ctx.parsed.y
              if (value === null || value === undefined) return ''
              return `${ctx.dataset.label}: ${customNumberFormatter(value, '-', 2)}${
                unit ? ` ${unit}` : ''
              }`
            }
          }
        }
      },
      scales: {
        x: {
          stacked,
          grid: { display: false },
          ticks: {
            font: { size: fontSize },
            color: textColors.titleColorRGBA,
            maxRotation: 45,
            minRotation: 0,
            autoSkip: true
          },
          border: { color: textColors.lineColorRGBA }
        },
        y: {
          stacked,
          ...(yRange ? { min: yRange[0], max: yRange[1] } : { beginAtZero: true }),
          grid: { color: textColors.lineColorRGBA },
          ticks: {
            font: { size: fontSize },
            color: textColors.titleColorRGBA,

            callback: (value: any) => customNumberFormatter(value, '-', 2)
          },
          border: { color: 'transparent' }
        }
      }
    }),
    [textColors, unit, fontSize, yRange, tooltipTitles, stacked, legend, onSelect]
  )

  const chartData = useMemo(
    () => ({
      labels,
      datasets: series.map((s) => ({
        type: 'bar' as const,
        label: s.label,
        data: s.data,
        backgroundColor: s.color,
        borderRadius: 4,
        maxBarThickness: 48
      }))
    }),
    [labels, series]
  )

  const hasValidData = series.some((s) => s.data.some((v) => v !== null && v !== undefined))

  return (
    <ChartShell containerRef={chartContainerRef} height={height} isLoading={isLoading} hasData={hasValidData} noDataText={noDataText}>
      <div className={`chart-bar${onSelect ? ' chart-selectable' : ''}`}>
        <Bar
          options={chartOptions as any}
          data={chartData as any}
          key={`${containerChange}-${changeKeyIndicator}`}
        />
      </div>
    </ChartShell>
  )
}

export default memo(ValleyGroupedBarChart)
