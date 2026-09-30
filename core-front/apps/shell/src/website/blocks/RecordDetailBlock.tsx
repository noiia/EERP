import Typography from '@mui/material/Typography'
import { pictureUrl } from '../urls'
import type { PublicDataSource, RecordDetailConfig } from '../types'
import { FieldLines, hasPicture } from './fields'

export async function RecordDetailBlock({ config, source, id }: { config: RecordDetailConfig; source: PublicDataSource; id?: string }) {
  if (!id) return null
  const rec = await source.get(config.table, id)
  if (!rec) return null
  return (
    <div>
      <Typography variant="h4" component="h2" gutterBottom>{String(rec[config.title_field] ?? '')}</Typography>
      {hasPicture(rec, config.picture_field) && (
        <img src={pictureUrl(config.table, id, config.picture_field)} alt="" style={{ maxWidth: '100%', height: 'auto' }} />
      )}
      <FieldLines record={rec} fields={config.fields} skip={config.title_field} />
    </div>
  )
}
