import Typography from '@mui/material/Typography'
import type { TextConfig } from '../types'

export function TextBlock({ config }: { config: TextConfig }) {
  return (
    <div>
      {config.heading && <Typography variant="h4" component="h2" gutterBottom sx={{ textAlign: config.align }}>{config.heading}</Typography>}
      {(config.body ?? '').split(/\n\s*\n/).filter(Boolean).map((p, i) => (
        <Typography key={i} component="p" sx={{ textAlign: config.align, mb: 2 }}>{p}</Typography>
      ))}
    </div>
  )
}
