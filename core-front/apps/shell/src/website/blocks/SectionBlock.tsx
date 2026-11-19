import Box from '@mui/material/Box'
import { recordsWithPicture } from '../pictures'
import { pictureUrl } from '../urls'
import type { PublicDataSource, SectionConfig } from '../types'
import { contrastText, HeroContent, hasHeroContent } from './HeroBlock'

/** A background band: color and/or a record's picture. Parallax = the picture stays
 * fixed while the page scrolls (CSS background-attachment; iOS Safari scrolls it
 * normally). Blocks overlapping it render on top (StackedGrid / the editor). */
export async function SectionBlock({ config, source }: { config: SectionConfig; source: PublicDataSource }) {
  const rec = config.table && config.field
    ? (await recordsWithPicture(source, { table: config.table, field: config.field, records: config.record ? [config.record] : undefined, limit: 1 }))[0]
    : undefined
  const content = hasHeroContent(config)
  const dim = Math.min(Math.max(config.dim ?? (content && rec ? 30 : 0), 0), 80) / 100
  const color = rec && content ? '#fff' : contrastText(config.color)
  return (
    <Box sx={{
      position: 'relative', height: '100%', minHeight: 48, overflow: 'hidden', bgcolor: config.color || undefined,
      ...(rec && {
        backgroundImage: `url("${pictureUrl(config.table!, String(rec.id), config.field!)}")`,
        backgroundSize: 'cover', backgroundPosition: 'center', backgroundAttachment: config.parallax ? 'fixed' : 'scroll',
      }),
    }}>
      {dim > 0 && <Box sx={{ position: 'absolute', inset: 0, bgcolor: `rgba(0,0,0,${dim})` }} />}
      {content && <HeroContent config={config} color={color} />}
    </Box>
  )
}
