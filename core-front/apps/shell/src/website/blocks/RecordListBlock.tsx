import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import CardActionArea from '@mui/material/CardActionArea'
import CardContent from '@mui/material/CardContent'
import Typography from '@mui/material/Typography'
import { pictureUrl } from '../urls'
import type { PublicDataSource, RecordCarouselConfig, RecordListConfig } from '../types'
import { FieldLines, hasPicture } from './fields'

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
      sx={side ? { width: `${width}%`, flexShrink: 0, objectFit: 'cover', alignSelf: 'stretch' } : { width: '100%', height: 'auto', display: 'block' }} />
  )
  // A side picture: picture and text side by side (row-reverse puts it right); on
  // top: stacked. The text never shrinks below its content (minWidth: 0 + wrap).
  const body = (
    <Box sx={{ display: 'flex', flexDirection: side ? (pos === 'right' ? 'row-reverse' : 'row') : 'column', height: '100%' }}>
      {picture}
      <CardContent sx={{ minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}>
        <Typography variant="h6" component="h3">{String(rec[config.title_field] ?? '')}</Typography>
        <FieldLines record={rec} fields={config.fields} skip={config.title_field} />
      </CardContent>
    </Box>
  )
  return (
    <Card sx={{ height: '100%' }}>
      {config.detail_slug ? <CardActionArea sx={{ height: '100%' }} href={`/${encodeURIComponent(config.detail_slug)}/${encodeURIComponent(id)}`}>{body}</CardActionArea> : body}
    </Card>
  )
}

export async function RecordListBlock({ config, source }: { config: RecordListConfig; source: PublicDataSource }) {
  const res = await source.list(config.table, { filter: config.filter, page_size: config.page_size ?? 12 })
  if (!res) return null
  const grid = config.display !== 'list'
  return (
    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: grid ? 'repeat(2, 1fr)' : '1fr', md: grid ? 'repeat(3, 1fr)' : '1fr' } }}>
      {res.records.map((rec) => <RecordCard key={String(rec.id)} config={config} rec={rec} />)}
    </Box>
  )
}
