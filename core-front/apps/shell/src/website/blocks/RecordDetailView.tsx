'use client'
import { useState } from 'react'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import { pictureUrl } from '../urls'
import type { RecordDetailConfig } from '../types'
import { FieldLines, hasPicture } from './fields'
import { ImageCarousel } from './ImageCarousel'

type Rec = Record<string, unknown>

/** Record detail: pictures (the record's, then each related row's) in a carousel, the
 * record's fields, and the related rows as a picker; picking one shows its fields and
 * moves the carousel to its picture. */
export function RecordDetailView({ config, rec, related }: { config: RecordDetailConfig; rec: Rec; related: Rec[] }) {
  const rel = config.related
  const [picked, setPicked] = useState<string | null>(related[0] ? String(related[0].id) : null)
  const [index, setIndex] = useState(0)
  const images = [
    ...(hasPicture(rec, config.picture_field) ? [{ id: String(rec.id), table: config.table, field: config.picture_field, alt: String(rec[config.title_field] ?? '') }] : []),
    ...(rel ? related.filter((r) => hasPicture(r, rel.picture_field)).map((r) => ({ id: String(r.id), table: rel.table, field: rel.picture_field!, alt: String(r[rel.title_field] ?? '') })) : []),
  ]
  const current = related.find((r) => String(r.id) === picked)
  const pick = (id: string | null) => {
    if (!id) return
    setPicked(id)
    const i = images.findIndex((im) => im.table === rel?.table && im.id === id)
    if (i >= 0) setIndex(i)
  }
  return (
    <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: '1fr', md: images.length > 0 ? '1fr 1fr' : '1fr' } }}>
      {images.length > 0 && (
        <div>
          <ImageCarousel images={images.map((im) => ({ src: pictureUrl(im.table, im.id, im.field), alt: im.alt }))} index={index} onIndexChange={setIndex} />
        </div>
      )}
      <div>
        <Stack spacing={1}>
          <Typography variant="h4" component="h2">{String(rec[config.title_field] ?? '')}</Typography>
          <FieldLines record={rec} fields={config.fields} skip={config.title_field} />
          {rel && related.length > 0 && (
            <>
              <ToggleButtonGroup exclusive size="small" value={picked} onChange={(_, v) => pick(v)} sx={{ flexWrap: 'wrap' }}>
                {related.map((r) => <ToggleButton key={String(r.id)} value={String(r.id)}>{String(r[rel.title_field] ?? r.id)}</ToggleButton>)}
              </ToggleButtonGroup>
              {current && <FieldLines record={current} fields={rel.fields} skip={rel.title_field} />}
            </>
          )}
        </Stack>
      </div>
    </Box>
  )
}
