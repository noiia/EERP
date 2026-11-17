'use client'
import { useRef } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import { useT } from '../i18n/translate'
import type { FieldDescriptor } from './descriptor'
import { useRelationLabels } from './use-relation-labels'
import type { WidgetProps } from './widgets'

// text/mindmap — read-only: this field's value in a centre box, one box per
// widgetOptions.satellites entry (label + sibling value, + `under`'s value as a
// second line) joined to it. A many2one satellite names its `entity` (and
// optional `labelField`) so its id resolves to a record label. widgetOptions.center names a
// sibling whose value is the centre box's (default: this field's own).
interface Satellite { field: string; label: string; under?: string; entity?: string; labelField?: string }

const dash = (v: string) => (v === '' ? '—' : v)

/** The centre box sized to its text: a short one keeps the 180×56 box at 14px; a longer one
 * gets a smaller font and a wider (up to 320), then taller (up to 220) box, so a long title
 * neither overflows nor dwarfs the satellites. Line count is estimated, not measured. */
export function centreBox(text: string): { font: number; w: number; h: number } {
  const n = text.length
  const font = n <= 40 ? 14 : n <= 100 ? 12 : 11
  const w = Math.min(320, Math.max(180, 180 + (n - 40) * 2))
  const perLine = Math.max(1, Math.floor((w - 16) / (font * 0.55)))
  const lines = Math.ceil(Math.max(n, 1) / perLine)
  return { font, w, h: Math.min(220, Math.max(56, Math.ceil(lines * font * 1.35) + 16)) }
}

export function MindmapWidget({ field, value, draft }: WidgetProps) {
  const t = useT()
  const th = useTheme()
  const box = useRef<HTMLDivElement>(null)
  const raw = field.widgetOptions?.satellites
  const sats = (Array.isArray(raw) ? raw : []).filter(
    (s) => typeof s === 'object' && s !== null && !Array.isArray(s) && typeof s.field === 'string',
  ) as unknown as Satellite[]
  const values = draft ?? {}
  const rel = sats.filter((s) => s.entity).map((s) => ({
    name: s.field, type: 'relation', relation: { entity: s.entity, kind: 'many2one', labelField: s.labelField ?? 'name' },
  }) as unknown as FieldDescriptor)
  const labelOf = useRelationLabels(rel, sats.map((s) => [s.field, values[s.field]]))
  // widgetOptions.center: a sibling field whose value fills the centre box (so the widget can
  // anchor on a virtual field while the real, editable field is shown elsewhere in the form).
  const centre = typeof field.widgetOptions?.center === 'string' ? values[field.widgetOptions.center] : value
  const show = (name: string) => (values[name] == null ? '' : labelOf(name, values[name]))

  const W = 180, H = 56, G = 24
  const centreText = dash(centre == null ? '' : String(centre))
  const c = centreBox(centreText)
  const rows = Math.ceil(sats.length / 2)
  const satsHeight = Math.max(rows, 1) * (H + G) + G
  const height = Math.max(satsHeight, c.h + 2 * G)
  const width = 2 * W + 3 * G + c.w
  const mid = height / 2
  const top = (height - satsHeight) / 2
  const pos = sats.map((_, i) => ({ x: i % 2 === 0 ? G : width - G - W, y: top + G + Math.floor(i / 2) * (H + G) }))
  const line = th.palette.divider

  const doExport = () => {
    const el = box.current
    if (!el) return
    void import('./diagram/export').then((m) => m.exportElementPng(el, 'mindmap', th.palette.background.paper))
  }

  return (
    <Box>
      <Box ref={box} sx={{ bgcolor: 'background.paper' }}>
        <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t(field.label ?? field.name)}>
          {sats.map((_, i) => (
            <line key={i} x1={width / 2} y1={mid} x2={pos[i].x + W / 2} y2={pos[i].y + H / 2} stroke={line} strokeWidth={2} />
          ))}
          <foreignObject x={width / 2 - c.w / 2} y={mid - c.h / 2} width={c.w} height={c.h}>
            <Box data-testid="mindmap-centre" sx={{ height: c.h, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', border: 2, borderColor: 'primary.main', borderRadius: 1, bgcolor: 'background.paper', p: 0.5, overflow: 'hidden' }}>
              <Typography variant="subtitle2" align="center" sx={{ fontSize: c.font, lineHeight: 1.3, overflowWrap: 'anywhere' }}>{centreText}</Typography>
            </Box>
          </foreignObject>
          {sats.map((s, i) => (
            <foreignObject key={s.field} x={pos[i].x} y={pos[i].y} width={W} height={H}>
              <Box sx={{ height: H, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.paper', p: 0.5, overflow: 'hidden' }}>
                <Typography variant="caption" color="text.secondary" noWrap component="div">{t(s.label)}</Typography>
                <Typography variant="body2" noWrap component="div">{dash(show(s.field))}</Typography>
                {s.under && <Typography variant="caption" noWrap component="div">{dash(show(s.under))}</Typography>}
              </Box>
            </foreignObject>
          ))}
        </svg>
      </Box>
      <Button size="small" onClick={doExport}>{t('Export PNG')}</Button>
    </Box>
  )
}
