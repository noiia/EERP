import Box from '@mui/material/Box'
import Link from '@mui/material/Link'
import Typography from '@mui/material/Typography'
import type { SxProps, Theme } from '@mui/material/styles'
import type { Presented } from '../field-format'
import type { SiteIconData } from '../field-icons'
import type { FieldColumn } from '../present'

// Draws presented fields (ADR-036): icon, label and value, the same in every block —
// record cards, the record list's table, the detail block. No hooks and no client-only
// API, so server components and the client record list both render it.

/** Text only assistive tech reads (a hidden label, a rating's spoken form). */
export const VISUALLY_HIDDEN = {
  position: 'absolute', width: 1, height: 1, p: 0, m: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
} as const

const GAP = { tight: '0.25em', normal: '0.5em', loose: '0.85em' } as const
const COLOR = { inherit: 'inherit', muted: 'text.secondary', accent: 'secondary.main' } as const

/** A Font Awesome icon as an inline SVG sized to the text (1em high, Font Awesome's own
 * baseline offset). Decorative: the label and value carry the meaning. */
export function SiteIcon({ data, sx }: { data: SiteIconData; sx?: SxProps<Theme> }) {
  const paths = Array.isArray(data.path) ? data.path : [data.path]
  return (
    <Box component="svg" viewBox={`0 0 ${data.width} ${data.height}`} aria-hidden focusable="false" data-icon={`${data.family}:${data.name}`}
      sx={[{ height: '1em', width: 'auto', verticalAlign: '-0.125em', overflow: 'visible', flexShrink: 0 }, ...(Array.isArray(sx) ? sx : [sx])]}>
      {paths.map((d, i) => <path key={i} d={d} fill="currentColor" opacity={paths.length > 1 && i === 0 ? 0.4 : 1} />)}
    </Box>
  )
}

/** One value with its column's icon (before or after), linked when actionable. */
export function FieldValue({ column, value }: { column: Pick<FieldColumn, 'icon'>; value: Presented }) {
  const icon = column.icon
  const mark = icon && (
    <SiteIcon data={icon.data} sx={{
      color: COLOR[icon.color],
      [icon.position === 'after' ? 'ml' : 'mr']: GAP[icon.spacing],
    }} />
  )
  const text = value.spoken
    ? <><span aria-hidden>{value.text}</span><Box component="span" sx={VISUALLY_HIDDEN}>{value.spoken}</Box></>
    : value.text
  const body = (
    <Box component="span" title={value.title} sx={{
      ...(value.nowrap && { whiteSpace: 'nowrap' }),
      ...(value.multiline && { whiteSpace: 'pre-line' }),
      overflowWrap: 'anywhere',
    }}>
      {value.swatch && <Box component="span" aria-hidden sx={{ display: 'inline-block', width: '0.9em', height: '0.9em', borderRadius: '2px', bgcolor: value.swatch, border: 1, borderColor: 'divider', verticalAlign: '-0.1em', mr: '0.4em' }} />}
      {text}
    </Box>
  )
  // The icon sits inside the link (one target, one focus stop), still aria-hidden.
  const content = <>{icon?.position !== 'after' && mark}{body}{icon?.position === 'after' && mark}</>
  return value.href
    ? <Link href={value.href} {...(value.external && { target: '_blank', rel: 'noopener noreferrer' })}>{content}</Link>
    : content
}

/** `label: value` lines, one per column with something to show. A hidden label stays in
 * the accessible name, so a bare value is never read out without its context. */
export function FieldLines({ columns, values }: { columns: FieldColumn[]; values: Record<string, Presented | null> | undefined }) {
  return columns.map((c) => {
    const v = values?.[c.name]
    if (!v) return null
    return (
      <Typography key={c.name} variant="body2" data-field={c.name} sx={{ overflowWrap: 'anywhere' }}>
        {c.label !== null
          ? <><Box component="span" sx={{ color: 'text.secondary' }}>{c.label}:</Box> </>
          : <Box component="span" sx={VISUALLY_HIDDEN}>{c.spoken}: </Box>}
        <FieldValue column={c} value={v} />
      </Typography>
    )
  })
}
