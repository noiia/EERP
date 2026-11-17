'use client'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import { alpha, type Theme } from '@mui/material/styles'
import { useT } from '../../i18n/translate'
import { usePhone } from '../use-phone'
import { band, matrixCells, type Band, type RiskRow } from './scoring'

const BAND_COLOR: Record<Band, 'success' | 'warning' | 'error'> = { low: 'success', medium: 'warning', high: 'error' }
// A cell holding at most this many risks names them ("6 - Budget cut"); a busier one shows only the criticity.
export const FULL_LABEL_MAX = 3

export const bandMain = (th: Theme, b: Band | null) => (b ? th.palette[BAND_COLOR[b]].main : th.palette.text.disabled)

// Likelihood (rows, 3 -> 1) against severity (columns, 1 -> 4); a cell is tinted by likelihood x severity,
// each chip by the risk's own criticity. `residual` plots the scores after remediation.
export function RiskMatrix({ rows, residual, onOpen }: { rows: RiskRow[]; residual: boolean; onOpen: (id: string) => void }) {
  const t = useT()
  const phone = usePhone()
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
                  <Chip
                    key={r.id}
                    size="small"
                    color={band(c) ? BAND_COLOR[band(c)!] : 'default'}
                    label={items.length <= FULL_LABEL_MAX ? `${value} - ${phone && r.name.length > 12 ? `${r.name.slice(0, 12)}…` : r.name}` : value}
                    aria-label={phone ? `${value} - ${r.name}` : undefined}
                    sx={{ maxWidth: '100%', ...(phone && { minHeight: 40 }) }}
                    title={r.name}
                    onClick={() => onOpen(r.id)}
                  />
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
