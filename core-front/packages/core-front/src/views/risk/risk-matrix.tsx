'use client'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { alpha, type Theme } from '@mui/material/styles'
import { useT } from '../../i18n/translate'
import { usePhone } from '../use-phone'
import { band, matrixCells, type Band, type RiskRow } from './scoring'

const BAND_COLOR: Record<Band, 'success' | 'warning' | 'error'> = { low: 'success', medium: 'warning', high: 'error' }
// A cell holding at most this many risks names them ("6 - Budget cut"); a busier one shows only the criticity.
export const FULL_LABEL_MAX = 3

export const bandMain = (th: Theme, b: Band | null) => (b ? th.palette[BAND_COLOR[b]].main : th.palette.text.disabled)

// Likelihood (rows, 3 -> 1) against severity (columns, 1 -> 4); a cell is tinted by likelihood x severity,
// each chip by the risk's own criticity. `residual` plots the scores after remediation; `wide`
// keeps the desktop layout whatever the screen (the export draws it off screen).
export function RiskMatrix({ rows, residual, onOpen, wide = false }: { rows: RiskRow[]; residual: boolean; onOpen: (id: string) => void; wide?: boolean }) {
  const t = useT()
  const phone = usePhone() && !wide
  const cells = matrixCells(rows, residual)
  const severities = [1, 2, 3, 4]
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: `auto repeat(${severities.length}, ${phone ? 'minmax(0, 1fr)' : 'minmax(120px, 1fr)'})`, gridTemplateRows: 'repeat(3, minmax(84px, 1fr)) auto', gap: 0.5, p: 2, width: '100%', height: '100%', boxSizing: 'border-box', bgcolor: 'background.paper' }}>
      {[3, 2, 1].map((l) => [
        <Box key={`l${l}`} sx={{ alignSelf: 'center', pr: 1, fontWeight: 600 }}>{`${t('Likelihood')} ${l}`}</Box>,
        ...severities.map((s) => {
          const items = cells.get(`${l}:${s}`) ?? []
          return (
            <Box
              key={`${l}:${s}`}
              data-testid={`cell-${l}:${s}`}
              sx={(th) => ({ minWidth: 0, p: 0.5, display: 'flex', flexWrap: 'wrap', gap: 0.5, alignContent: 'flex-start', borderRadius: 1, bgcolor: alpha(bandMain(th, band(l * s)), 0.2) })}
            >
              {items.map((r) => {
                const c = residual ? r.residual_criticity : r.criticity
                const value = c ?? '—'
                return (
                  <Tooltip key={r.id} placement="top" title={<RiskTip risk={r} residual={residual} />}>
                  <Chip
                    size="small"
                    color={band(c) ? BAND_COLOR[band(c)!] : 'default'}
                    label={items.length <= FULL_LABEL_MAX ? `${value} - ${phone && r.name.length > 12 ? `${r.name.slice(0, 12)}…` : r.name}` : value}
                    aria-label={phone ? `${value} - ${r.name}` : undefined}
                    sx={{ maxWidth: '100%', ...(phone && { minHeight: 40 }) }}
                    onClick={() => onOpen(r.id)}
                  />
                  </Tooltip>
                )
              })}
            </Box>
          )
        }),
      ])}
      <Box />
      {severities.map((s) => <Box key={s} sx={{ textAlign: 'center', fontWeight: 600 }}>{`${t('Severity')} ${s}`}</Box>)}
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
