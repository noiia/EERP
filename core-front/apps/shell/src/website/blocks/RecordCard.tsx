import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import CardActionArea from '@mui/material/CardActionArea'
import CardContent from '@mui/material/CardContent'
import Typography from '@mui/material/Typography'
import { pictureUrl } from '../urls'
import type { RecordCarouselConfig, RecordListConfig } from '../types'
import { FieldLines, hasPicture } from './fields'

/** The site's card look (record and event cards): soft border, rounded, lifts on hover. */
export const CARD_SX = {
  height: '100%', borderRadius: 3, border: 1, borderColor: 'divider', boxShadow: 'none', transition: 'box-shadow .2s, transform .2s',
  '&:hover': { boxShadow: 6, transform: 'translateY(-2px)' },
} as const
/** A picture on top of a card: 4:3, cropped to fill. */
export const CARD_PICTURE_SX = { width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', display: 'block' } as const

type CardConfig = Pick<RecordListConfig, 'table' | 'fields' | 'title_field' | 'picture_field' | 'detail_slug'> &
  Pick<RecordCarouselConfig, 'picture_position' | 'picture_width'>

/** One record as a card (picture, title, field lines), linking to its detail page
 * when a detail slug is set. Shared by the list and carousel blocks. */
export function RecordCard({ config, rec }: { config: CardConfig; rec: Record<string, unknown> }) {
  const id = String(rec.id)
  const pos = config.picture_position ?? 'top'
  const side = pos !== 'top'
  const width = Math.min(Math.max(config.picture_width ?? 40, 10), 90)
  const picture = hasPicture(rec, config.picture_field) && (
    <Box component="img" src={pictureUrl(config.table, id, config.picture_field)} alt="" loading="lazy"
      sx={side ? { width: `${width}%`, flexShrink: 0, objectFit: 'cover', alignSelf: 'stretch' } : CARD_PICTURE_SX} />
  )
  // A side picture: picture and text side by side (row-reverse puts it right); on
  // top: stacked. The text never shrinks below its content (minWidth: 0 + wrap).
  const body = (
    <Box sx={{ display: 'flex', flexDirection: side ? (pos === 'right' ? 'row-reverse' : 'row') : 'column', height: '100%' }}>
      {picture}
      <CardContent sx={{ minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}>
        <Typography variant="h6" component="h3" sx={{ fontWeight: 600, lineHeight: 1.3, mb: 0.5 }}>{String(rec[config.title_field] ?? '')}</Typography>
        <FieldLines record={rec} fields={config.fields} skip={config.title_field} />
      </CardContent>
    </Box>
  )
  return (
    <Card sx={CARD_SX}>
      {config.detail_slug ? <CardActionArea sx={{ height: '100%' }} href={`/${encodeURIComponent(config.detail_slug)}/${encodeURIComponent(id)}`}>{body}</CardActionArea> : body}
    </Card>
  )
}
