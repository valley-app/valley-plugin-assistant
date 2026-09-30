import { useEffect, useState, useRef, type RefObject } from 'react'

/**
 * Toggle a boolean on (debounced) container resize so imperative chart canvases
 * re-render at the right size. Ported 1:1 from the reference implementation.
 */
export function useChartContainerResize(
  chartContainerRef: RefObject<HTMLElement | null>,
  changeKeyIndicator?: boolean | number,
  delay = 300
): boolean {
  const [changed, setChanged] = useState(false)
  const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const isInitialObservation = useRef(true)

  useEffect(() => {
    const container = chartContainerRef.current
    if (!container) return
    isInitialObservation.current = true

    const handleResize = (): void => {
      if (isInitialObservation.current) {
        isInitialObservation.current = false
        return
      }
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current)
      resizeTimeoutRef.current = setTimeout(() => setChanged((prev) => !prev), delay)
    }

    const Observer = container.ownerDocument.defaultView?.ResizeObserver ?? ResizeObserver
    resizeObserverRef.current = new Observer(handleResize)
    resizeObserverRef.current.observe(container)

    return () => {
      resizeObserverRef.current?.disconnect()
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current)
    }
  }, [chartContainerRef, delay, changeKeyIndicator])

  return changed
}
