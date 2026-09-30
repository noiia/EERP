import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { safeHref } from '../urls'
import type { HeroConfig } from '../types'

const FLEX = { left: 'flex-start', top: 'flex-start', center: 'center', right: 'flex-end', bottom: 'flex-end' } as const
const PADDING = { none: 0, compact: 2, normal: 4, spacious: 8 } as const

// Fills its grid cell (height 100%), so resizing the block moves the content with
// it: alignment decides where. Only the parts that are set render — a lone button
// takes a button's space, not a title's.
export function HeroBlock({ config }: { config: HeroConfig }) {
  const href = safeHref(config.cta_href)
  const align = config.align ?? 'center'
  const full = config.button_width === 'full'
  return (
    <Box sx={{
      height: '100%', display: 'flex', flexDirection: 'column', gap: 1,
      alignItems: full ? 'stretch' : FLEX[align], justifyContent: FLEX[config.valign ?? 'center'],
      textAlign: align, p: PADDING[config.padding ?? 'normal'], boxSizing: 'border-box',
    }}>
      {config.title && <Typography variant="h3" component="h1" sx={{ overflowWrap: 'anywhere' }}>{config.title}</Typography>}
      {config.subtitle && <Typography variant="h6" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{config.subtitle}</Typography>}
      {config.cta_label && href && (
        <Button variant="contained" href={href} size={config.button_size ?? 'large'} fullWidth={full}
          sx={{ mt: config.title || config.subtitle ? 1 : 0, maxWidth: '100%', whiteSpace: 'normal' }}>
          {config.cta_label}
        </Button>
      )}
    </Box>
  )
}
