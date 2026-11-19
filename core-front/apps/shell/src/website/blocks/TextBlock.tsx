import Typography from '@mui/material/Typography'
import type { TextConfig } from '../types'

export function TextBlock({ config }: { config: TextConfig }) {
  return (
    <div style={{ textAlign: config.align }}>
      {config.heading && (
        <Typography variant="h2" gutterBottom>
          {config.heading}
        </Typography>
      )}
      {(config.body ?? '').split(/\n\s*\n/).filter(Boolean).map((p, i) => (
        // ~70 characters a line: centered/right text keeps its column, aligned to its side.
        <Typography key={i} component="p" sx={{ mb: 2, lineHeight: 1.75, whiteSpace: 'pre-line', maxWidth: '70ch',
          mx: config.align === 'center' ? 'auto' : undefined, ml: config.align === 'right' ? 'auto' : undefined }}>{p}</Typography>
      ))}
    </div>
  )
}
