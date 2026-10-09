import Typography from '@mui/material/Typography'
import type { TextConfig } from '../types'

export function TextBlock({ config }: { config: TextConfig }) {
  return (
    <div style={{ textAlign: config.align }}>
      {config.heading && (
        <Typography variant="h4" component="h2" gutterBottom sx={{ fontWeight: 700, letterSpacing: '-0.01em', textWrap: 'balance' }}>
          {config.heading}
        </Typography>
      )}
      {(config.body ?? '').split(/\n\s*\n/).filter(Boolean).map((p, i) => (
        <Typography key={i} component="p" sx={{ mb: 2, lineHeight: 1.75, whiteSpace: 'pre-line' }}>{p}</Typography>
      ))}
    </div>
  )
}
