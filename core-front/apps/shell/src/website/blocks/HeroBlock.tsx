import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { safeHref } from '../urls'
import type { HeroConfig } from '../types'

const FLEX = { left: 'flex-start', top: 'flex-start', center: 'center', right: 'flex-end', bottom: 'flex-end' } as const
const PADDING = { none: 0, compact: 2, normal: 4, spacious: 8 } as const

/** Whether a config carries any hero content to lay over a picture or a section. */
export const hasHeroContent = (c: HeroConfig) => !!(c.title || c.subtitle || (c.cta_label && safeHref(c.cta_href)))

/** Readable text color on `hex` (#rgb / #rrggbb); undefined for anything else. */
export function contrastText(hex: string | undefined): string | undefined {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex ?? '')
  if (!m) return undefined
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? 'rgba(0,0,0,0.87)' : '#fff'
}

// Fills its box (height 100%), so resizing the block moves the content with it:
// alignment decides where. Only the parts that are set render — a lone button takes a
// button's space, not a title's. `color` set (over a picture or a colored section):
// text inherits it instead of the theme's.
export function HeroContent({ config, color }: { config: HeroConfig; color?: string }) {
  const href = safeHref(config.cta_href)
  const align = config.align ?? 'center'
  const full = config.button_width === 'full'
  return (
    <Box sx={{
      position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', gap: 1.5,
      alignItems: full ? 'stretch' : FLEX[align], justifyContent: FLEX[config.valign ?? 'center'],
      textAlign: align, p: PADDING[config.padding ?? 'normal'], boxSizing: 'border-box', color,
    }}>
      {config.title && (
        <Typography variant="h3" component="h1" sx={{ fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.1, overflowWrap: 'anywhere', textWrap: 'balance' }}>
          {config.title}
        </Typography>
      )}
      {config.subtitle && (
        <Typography variant="h6" component="p" sx={{ fontWeight: 400, opacity: color ? 0.9 : 1, color: color ? 'inherit' : 'text.secondary', maxWidth: '60ch', overflowWrap: 'anywhere' }}>
          {config.subtitle}
        </Typography>
      )}
      {config.cta_label && href && (
        <Button variant="contained" disableElevation href={href} size={config.button_size ?? 'large'} fullWidth={full}
          sx={{ mt: config.title || config.subtitle ? 1.5 : 0, maxWidth: '100%', whiteSpace: 'normal', borderRadius: 999, px: 3.5, fontWeight: 700, textTransform: 'none' }}>
          {config.cta_label}
        </Button>
      )}
    </Box>
  )
}

export function HeroBlock({ config }: { config: HeroConfig }) {
  return <HeroContent config={config} />
}
