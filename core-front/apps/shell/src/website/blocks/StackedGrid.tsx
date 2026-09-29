import Box from '@mui/material/Box'
import type { ReactNode } from 'react'
import { stackOrder, type Block } from '../types'

/** Desktop: the saved 12-column grid; below md: one column in (y, x) order. */
export function StackedGrid({ blocks, render }: { blocks: Block[]; render: (b: Block) => ReactNode }) {
  return (
    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(12, 1fr)' }, gridAutoRows: { md: 'minmax(40px, auto)' } }}>
      {stackOrder(blocks).map((b) => (
        <Box key={b.id} sx={{ gridColumn: { md: `${b.x + 1} / span ${b.w}` }, gridRow: { md: `${b.y + 1} / span ${b.h}` }, minWidth: 0 }}>
          {render(b)}
        </Box>
      ))}
    </Box>
  )
}
