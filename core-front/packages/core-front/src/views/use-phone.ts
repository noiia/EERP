'use client'
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import useMediaQuery from '@mui/material/useMediaQuery'
import { layout } from './tokens'

/** True below `layout.phoneMaxWidth` — the one JS phone switch (same query as AppTopBar).
 * Re-renders on a viewport change, never remounts. Server and first paint render desktop. */
export function usePhone(): boolean {
  return useMediaQuery(`(max-width:${layout.phoneMaxWidth - 0.05}px)`, { noSsr: false })
}

/** Phone only: a CSS height that fills the screen from the element's own top to the bottom
 * edge (its page offset, so scrolling doesn't change it), for canvases whose chrome above
 * varies. Re-measured after every render and on resize; `undefined` until measured. */
export function useFillHeight(ref: RefObject<HTMLElement | null>, on: boolean): string | undefined {
  const [top, setTop] = useState<number | null>(null)
  const measure = () => {
    const el = ref.current
    if (on && el) setTop(Math.round(el.getBoundingClientRect().top + window.scrollY))
  }
  useLayoutEffect(measure)
  useEffect(() => {
    if (!on) return
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [on])
  return on ? `calc(100dvh - ${top ?? 0}px - 8px)` : undefined
}
