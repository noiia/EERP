'use client'
import { useLayoutEffect, useRef, useState } from 'react'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { alpha, type Theme } from '@mui/material/styles'
import { useT } from '../../i18n/translate'
import { usePhone } from '../use-phone'
import { band, matrixCells, RISK_LIKELIHOODS, RISK_SEVERITIES, type Band, type RiskRow } from './scoring'

const BAND_COLOR: Record<Band, 'success' | 'warning' | 'error'> = { low: 'success', medium: 'warning', high: 'error' }

export const bandMain = (th: Theme, b: Band | null) => (b ? th.palette[BAND_COLOR[b]].main : th.palette.text.disabled)

// Likelihood (rows, 3 -> 1) against severity (columns, 1 -> 4); a cell is tinted by likelihood x severity,
// each chip by the risk's own criticity. `residual` plots the scores after remediation; `wide`
// keeps the desktop layout whatever the screen (the export draws it off screen).
export function RiskMatrix({ rows, residual, onOpen, wide = false }: { rows: RiskRow[]; residual: boolean; onOpen: (id: string) => void; wide?: boolean }) {
  const t = useT()
  const phone = usePhone() && !wide
  const cells = matrixCells(rows, residual)
  const severities = RISK_SEVERITIES
  // Phone: "P3" (the translated label's first letter) instead of "Probabilité 3"; the full name stays as the title.
  const axis = (label: string, n: number) => {
    const full = `${t(label)} ${n}`
    return phone ? <span title={full} aria-label={full}>{`${t(label).charAt(0).toUpperCase()}${n}`}</span> : full
  }
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: `auto repeat(${severities.length}, ${phone ? 'minmax(0, 1fr)' : 'minmax(120px, 1fr)'})`, gridTemplateRows: 'repeat(3, minmax(84px, 1fr)) auto', gap: 0.5, p: 2, width: '100%', height: '100%', boxSizing: 'border-box', bgcolor: 'background.paper' }}>
      {RISK_LIKELIHOODS.map((l) => [
        <Box key={`l${l}`} sx={{ alignSelf: 'center', pr: 1, fontWeight: 600 }}>{axis('Likelihood', l)}</Box>,
        ...severities.map((s) => {
          const items = cells.get(`${l}:${s}`) ?? []
          return <RiskCell key={`${l}:${s}`} id={`${l}:${s}`} tone={band(l * s)} items={items} residual={residual} phone={phone} onOpen={onOpen} />
        }),
      ])}
      <Box />
      {severities.map((s) => <Box key={s} sx={{ textAlign: 'center', fontWeight: 600 }}>{axis('Severity', s)}</Box>)}
    </Box>
  )
}

// A cell names its risks ("6 - Budget cut") and falls back to the bare criticity only
// when the named chips overflow it; a resize re-measures from the full labels.
function RiskCell({ id, tone, items, residual, phone, onOpen }: { id: string; tone: Band | null; items: RiskRow[]; residual: boolean; phone: boolean; onOpen: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)
  const [size, setSize] = useState('')
  useLayoutEffect(() => setCompact(false), [items, residual, phone, size])
  useLayoutEffect(() => {
    const el = ref.current
    if (!compact && el && el.scrollHeight > el.clientHeight + 1) setCompact(true)
  })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setSize(`${Math.round(e.contentRect.width)}x${Math.round(e.contentRect.height)}`))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <Box
      ref={ref}
      data-testid={`cell-${id}`}
      sx={(th) => ({ minWidth: 0, minHeight: 0, overflow: 'hidden', p: 0.5, display: 'flex', flexWrap: 'wrap', gap: 0.5, alignContent: 'flex-start', borderRadius: 1, bgcolor: alpha(bandMain(th, tone), 0.2) })}
    >
      {items.map((r) => {
        const c = residual ? r.residual_criticity : r.criticity
        const value = c ?? '—'
        return (
          <Tooltip key={r.id} placement="top" title={<RiskTip risk={r} residual={residual} />}>
            <Chip
              size="small"
              color={band(c) ? BAND_COLOR[band(c)!] : 'default'}
              label={compact ? value : `${value} - ${phone && r.name.length > 12 ? `${r.name.slice(0, 12)}…` : r.name}`}
              aria-label={phone || compact ? `${value} - ${r.name}` : undefined}
              sx={{ maxWidth: '100%', ...(phone && { minHeight: 40 }) }}
              onClick={() => onOpen(r.id)}
            />
          </Tooltip>
        )
      })}
    </Box>
  )
}

const show = (v: number | string | null | undefined) => (v == null || v === '' ? '—' : String(v))

/** The hover tile over a matrix chip: the risk's title, its scores (current → after
 * remediation, the mode's side in bold), its remediation and its "if it happens" plan. */
export function RiskTip({ risk: r, residual }: { risk: RiskRow; residual: boolean }) {
  const t = useT()
  const scores: [string, number | null | undefined, number | null | undefined][] = [
    ['Likelihood', r.likelihood, r.residual_likelihood],
    ['Severity', r.severity_effective, r.residual_severity],
    ['Detectability', r.detectability, r.residual_detectability],
    ['Criticity', r.criticity, r.residual_criticity],
  ]
  const text = (label: string, v: string | null | undefined) => (
    <Box sx={{ mt: 0.75 }}>
      <Typography variant="body2" sx={{ fontWeight: 600, display: 'block' }}>{t(label)}</Typography>
      <Typography variant="body2" sx={{ display: 'block', whiteSpace: 'pre-line' }}>{show(v)}</Typography>
    </Box>
  )
  return (
    <Box data-testid="risk-tip" sx={{ maxWidth: 320 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{r.name}</Typography>
      {/* Each value right next to its label (max-content columns), not pushed to the far edge. */}
      <Box component="dl" sx={{ m: 0, mt: 0.5, display: 'grid', gridTemplateColumns: 'max-content max-content', columnGap: 1, '& dd': { m: 0 } }}>
        {scores.map(([label, now, after]) => [
          <Typography key={`${label}-k`} component="dt" variant="body2">{`${t(label)} :`}</Typography>,
          // Current → after remediation; the pair the matrix's mode plots is bold.
          <Typography key={`${label}-v`} component="dd" variant="body2">
            <Box component="span" sx={{ fontWeight: residual ? 400 : 700 }}>{show(now)}</Box>
            {' → '}
            <Box component="span" sx={{ fontWeight: residual ? 700 : 400 }}>{show(after)}</Box>
          </Typography>,
        ])}
      </Box>
      {text('Remediation', r.remediation)}
      {text('If it happens', r.if_it_happens)}
    </Box>
  )
}
