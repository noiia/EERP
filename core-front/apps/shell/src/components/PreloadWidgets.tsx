'use client'
import { useEffect } from 'react'
import { preloadLazyComponents } from '@eerp/core-front'

// The engine's heavy widgets (data grid, tree view, rich-text editor, Graph mode)
// ship in their own chunks, so the first page loads without them. Once the browser
// is idle this loads them all, so the next list, graph or HTML field renders at
// once instead of waiting on a chunk — and never shows a Suspense fallback, which
// would cost ~300 ms (see core-front/CLAUDE.md, "No route loading screen").
// Mounted once by the ERP layout. Renders nothing.
export function PreloadWidgets() {
  useEffect(() => {
    const load = () => void preloadLazyComponents().catch(() => {})
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(load, { timeout: 2000 })
      return () => window.cancelIdleCallback(handle)
    }
    const handle = window.setTimeout(load, 200)
    return () => window.clearTimeout(handle)
  }, [])
  return null
}
