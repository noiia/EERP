'use client'
import { useCallback, useLayoutEffect, useState } from 'react'

/**
 * The width of an element, kept current with a ResizeObserver — the same
 * `{ width, containerRef, mounted }` shape as react-grid-layout's
 * `useContainerWidth`, without importing that library into every page (the
 * top bar's menu row uses it; Graph mode, which needs the library anyway,
 * keeps the original). `mounted` turns true once a first measure is in.
 */
export function useContainerWidth(): {
  width: number
  containerRef: (node: HTMLElement | null) => void
  mounted: boolean
} {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState(0)
  const [mounted, setMounted] = useState(false)
  const containerRef = useCallback((el: HTMLElement | null) => setNode(el), [])

  useLayoutEffect(() => {
    if (!node) return
    const measure = () => {
      setWidth(node.offsetWidth)
      setMounted(true)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])

  return { width, containerRef, mounted }
}
