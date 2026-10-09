import Box from '@mui/material/Box'
import { recordsWithPicture } from '../pictures'
import { pictureUrl, safeHref } from '../urls'
import type { ImageConfig, PublicDataSource } from '../types'
import { HeroContent, hasHeroContent } from './HeroBlock'

/** A record's picture filling the block; unset record = the table's first one holding a
 * picture. Hero content set: laid over the picture on a dark scrim (the link then
 * stays on the button, not the whole picture). */
export async function ImageBlock({ config, source }: { config: ImageConfig; source: PublicDataSource }) {
  if (!config.table || !config.field) return null
  const rec = (await recordsWithPicture(source, { table: config.table, field: config.field, records: config.record ? [config.record] : undefined, limit: 1 }))[0]
  if (!rec) return null
  const overlay = hasHeroContent(config)
  const href = overlay ? undefined : safeHref(config.href)
  const img = (
    <Box component="img" src={pictureUrl(config.table, String(rec.id), config.field)} alt={config.alt ?? ''} loading="lazy"
      sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: config.fit ?? 'cover', transition: 'transform .4s ease' }} />
  )
  return (
    <Box sx={{
      position: 'relative', height: '100%', minHeight: 160, borderRadius: 2, overflow: 'hidden',
      ...(href && { '&:hover img': { transform: 'scale(1.03)' } }),
    }}>
      {href ? <a href={href}>{img}</a> : img}
      {overlay && <>
        <Box sx={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,.15), rgba(0,0,0,.55))' }} />
        <HeroContent config={config} color="#fff" />
      </>}
    </Box>
  )
}
