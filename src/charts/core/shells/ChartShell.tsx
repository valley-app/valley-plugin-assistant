import React from 'react'
import type { ReactNode, RefObject } from 'react'
import LoadingCircle from './LoadingCircle'

export default function ChartShell({ containerRef, height, isLoading, hasData, noDataText, children }: {
  containerRef: RefObject<HTMLDivElement>
  height: number
  isLoading: boolean
  hasData: boolean
  noDataText: string
  children: ReactNode
}): JSX.Element {
  return (
    <div ref={containerRef} className="chart-container" style={{ height: height === -1 ? '100%' : `${height}px` }}>
      <div className="chart-wrapper">
        {isLoading ? (
          <div className="loading-center-wrapper"><LoadingCircle /></div>
        ) : hasData ? children : (
          <div className="chart-nodata unselectable"><i>{noDataText}</i></div>
        )}
      </div>
    </div>
  )
}
