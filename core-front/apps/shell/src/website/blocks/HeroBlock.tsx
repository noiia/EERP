import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { safeHref } from '../urls'
import type { HeroConfig } from '../types'

export function HeroBlock({ config }: { config: HeroConfig }) {
  const href = safeHref(config.cta_href)
  return (
    <Box sx={{ py: 6, textAlign: 'center' }}>
      <Typography variant="h3" component="h1" gutterBottom>{config.title}</Typography>
      {config.subtitle && <Typography variant="h6" color="text.secondary" gutterBottom>{config.subtitle}</Typography>}
      {config.cta_label && href && (
        <Button variant="contained" href={href} sx={{ mt: 2 }}>{config.cta_label}</Button>
      )}
    </Box>
  )
}
