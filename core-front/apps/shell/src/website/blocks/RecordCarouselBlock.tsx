import Box from '@mui/material/Box'
import type { PublicDataSource, RecordCarouselConfig } from '../types'
import { RecordCard } from './RecordCard'

/** Hand-picked records (in the chosen order) or the table's first ones, capped at
 * `limit`, as a horizontal row of cards. Native scroll-snap: swipe on touch, scroll
 * or shift+wheel on desktop. ponytail: no prev/next arrows; add a client wrapper if asked. */
export async function RecordCarouselBlock({ config, source }: { config: RecordCarouselConfig; source: PublicDataSource }) {
  const limit = Math.min(Math.max(config.limit ?? 10, 1), 100)
  let records: Record<string, unknown>[]
  if (config.records?.length) {
    const got = await Promise.all(config.records.slice(0, limit).map((id) => source.get(config.table, id)))
    records = got.filter((r): r is Record<string, unknown> => r != null) // unpublished/deleted ones drop out
  } else {
    records = (await source.list(config.table, { filter: config.filter, page_size: limit }))?.records ?? []
  }
  if (records.length === 0) return null
  const cardWidth = Math.min(Math.max(config.card_width ?? (config.picture_position && config.picture_position !== 'top' ? 480 : 280), 160), 1200)
  return (
    <Box sx={{ display: 'flex', gap: 2, overflowX: 'auto', scrollSnapType: 'x mandatory', pb: 1 }}>
      {records.map((rec) => (
        <Box key={String(rec.id)} sx={{ flex: `0 0 min(${cardWidth}px, 85%)`, scrollSnapAlign: 'start' }}>
          <RecordCard config={config} rec={rec} />
        </Box>
      ))}
    </Box>
  )
}
