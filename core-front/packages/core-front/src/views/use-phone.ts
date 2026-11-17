import useMediaQuery from '@mui/material/useMediaQuery'
import { layout } from './tokens'

/** True below `layout.phoneMaxWidth` — the one JS phone switch (same query as AppTopBar).
 * Re-renders on a viewport change, never remounts. Server and first paint render desktop. */
export function usePhone(): boolean {
  return useMediaQuery(`(max-width:${layout.phoneMaxWidth - 0.05}px)`, { noSsr: false })
}
