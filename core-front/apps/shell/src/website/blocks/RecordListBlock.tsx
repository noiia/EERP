import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import CardActionArea from '@mui/material/CardActionArea'
import CardContent from '@mui/material/CardContent'
import Typography from '@mui/material/Typography'
import { pictureUrl } from '../urls'
import type { PublicDataSource, RecordListConfig } from '../types'
import { FieldLines, hasPicture } from './fields'

type CardConfig = Pick<RecordListConfig, 'table' | 'fields' | 'title_field' | 'picture_field' | 'detail_slug'>

/** One record as a card (picture, title, field lines), linking to its detail page
 * when a detail slug is set. Shared by the list and carousel blocks. */
export function RecordCard({ config, rec }: { config: CardConfig; rec: Record<string, unknown> }) {
  const id = String(rec.id)
  const body = (
    <>
      {hasPicture(rec, config.picture_field) && (
        <img src={pictureUrl(config.table, id, config.picture_field)} alt="" loading="lazy" style={{ width: '100%', height: 'auto' }} />
      )}
      <CardContent>
        <Typography variant="h6" component="h3">{String(rec[config.title_field] ?? '')}</Typography>
        <FieldLines record={rec} fields={config.fields} skip={config.title_field} />
      </CardContent>
    </>
  )
  return (
    <Card sx={{ height: '100%' }}>
      {config.detail_slug ? <CardActionArea href={`/${encodeURIComponent(config.detail_slug)}/${encodeURIComponent(id)}`}>{body}</CardActionArea> : body}
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
