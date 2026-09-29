import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import CardActionArea from '@mui/material/CardActionArea'
import CardContent from '@mui/material/CardContent'
import Typography from '@mui/material/Typography'
import { pictureUrl } from '../public-api'
import type { PublicDataSource, RecordListConfig } from '../types'
import { FieldLines } from './fields'

export async function RecordListBlock({ config, source }: { config: RecordListConfig; source: PublicDataSource }) {
  const res = await source.list(config.table, { filter: config.filter, page_size: config.page_size ?? 12 })
  if (!res) return null
  const grid = config.display !== 'list'
  return (
    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: grid ? 'repeat(2, 1fr)' : '1fr', md: grid ? 'repeat(3, 1fr)' : '1fr' } }}>
      {res.records.map((rec) => {
        const id = String(rec.id)
        const body = (
          <>
            {config.picture_field && (
              <img src={pictureUrl(config.table, id, config.picture_field)} alt="" loading="lazy" style={{ width: '100%', height: 'auto' }} />
            )}
            <CardContent>
              <Typography variant="h6" component="h3">{String(rec[config.title_field] ?? '')}</Typography>
              <FieldLines record={rec} fields={config.fields} skip={config.title_field} />
            </CardContent>
          </>
        )
        return (
          <Card key={id}>
            {config.detail_slug ? <CardActionArea href={`/${config.detail_slug}/${id}`}>{body}</CardActionArea> : body}
          </Card>
        )
      })}
    </Box>
  )
}
