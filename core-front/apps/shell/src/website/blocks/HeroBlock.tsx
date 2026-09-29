import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import type { HeroConfig } from '../types'

export function HeroBlock({ config }: { config: HeroConfig }) {
  return (
    <Box sx={{ py: 6, textAlign: 'center' }}>
      <Typography variant="h3" component="h1" gutterBottom>{config.title}</Typography>
      {config.subtitle && <Typography variant="h6" color="text.secondary" gutterBottom>{config.subtitle}</Typography>}
      {config.cta_label && config.cta_href && (
        <Button variant="contained" href={config.cta_href} sx={{ mt: 2 }}>{config.cta_label}</Button>
      )}
    </Box>
  )
}
