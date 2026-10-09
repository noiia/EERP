import Box from '@mui/material/Box'
import type { ReactNode } from 'react'
import { sectionOf, stackOrder, type Block, type SectionConfig } from '../types'
import { contrastText, hasHeroContent } from './HeroBlock'

/** Desktop: the saved 36-column grid (12px rows, 8px gaps — GRID in layout-ops); below
 * md: one column in (y, x) order. Sections come first in the DOM, so blocks overlapping
 * them paint on top. On a phone a section can't sit behind anything: the blocks it
 * contains take its color instead (gaps become padding so they join into one band),
 * and a section with no content of its own is hidden. */
export function StackedGrid({ blocks, render }: { blocks: Block[]; render: (b: Block) => ReactNode }) {
  const sections = blocks.filter((b) => b.type === 'section')
  const ordered = [...sections, ...blocks.filter((b) => b.type !== 'section')]
  const rank = new Map(stackOrder(blocks).map((b, i) => [b.id, i]))
  return (
    <Box sx={{ display: 'grid', gap: { xs: 0, md: 1 }, gridTemplateColumns: { xs: '1fr', md: 'repeat(36, 1fr)' }, gridAutoRows: { md: 'minmax(12px, auto)' } }}>
      {ordered.map((b) => {
        const sc = b.type === 'section' ? (b.config as SectionConfig) : undefined
        const parent = sc ? undefined : sectionOf(b, sections)
        const pc = parent?.config as SectionConfig | undefined
        return (
          <Box key={b.id} sx={{
            gridColumn: { md: `${b.x + 1} / span ${b.w}` }, gridRow: { md: `${b.y + 1} / span ${b.h}` }, minWidth: 0,
            // Phone order: (y, x) like the rest, sections included.
            order: { xs: rank.get(b.id), md: 0 },
            py: { xs: sc ? 0 : 1, md: 0 },
            ...(sc && !hasHeroContent(sc) && { display: { xs: 'none', md: 'block' } }),
            ...(pc && { color: pc.table && pc.field ? '#fff' : contrastText(pc.color), bgcolor: { xs: pc.color || 'transparent', md: 'transparent' }, px: { xs: pc.color ? 2 : 0, md: 0 } }),
          }}>
            {render(b)}
          </Box>
        )
      })}
    </Box>
  )
}
