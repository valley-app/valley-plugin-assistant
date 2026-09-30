import React from 'react'
import { createRoot } from 'react-dom/client'
import ValleyAreaChart, { type ValleyAreaChartProps } from './ValleyAreaChart'
import ValleyGroupedBarChart, { type ValleyGroupedBarChartProps } from './ValleyGroupedBarChart'
import { initLocalization } from '../localization'
import type { ValleyPluginApi } from '../api'

type ChartSpec = { kind: 'area'; props: ValleyAreaChartProps } | { kind: 'bar'; props: ValleyGroupedBarChartProps }
function mount(element: HTMLElement, spec: ChartSpec, api: ValleyPluginApi): { update(spec: ChartSpec): void; destroy(): void } {
  initLocalization(api)
  const root = createRoot(element)
  const update = (next: ChartSpec): void => root.render(next.kind === 'area' ? <ValleyAreaChart {...next.props} /> : <ValleyGroupedBarChart {...next.props} />)
  update(spec)
  return { update, destroy: () => root.unmount() }
}
Object.assign(window, { valleyAssistantCharts: { mount } })
