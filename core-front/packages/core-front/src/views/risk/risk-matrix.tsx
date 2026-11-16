'use client'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import { alpha, type Theme } from '@mui/material/styles'
import { useT } from '../../i18n/translate'
import { band, matrixCells, type Band, type RiskRow } from './scoring'

const BAND_COLOR: Record<Band, 'success' | 'warning' | 'error'> = { low: 'success', medium: 'warning', high: 'error' }
export const bandMain = (th: Theme, b: Band | null) => (b ? th.palette[BAND_COLOR[b]].main : th.palette.text.disabled)

// Likelihood (rows, 3 -> 1) against severity (columns, 1 -> 4); a cell is tinted by likelihood x severity,
// each chip by the risk's own criticity. `residual` plots the scores after remediation.
export function RiskMatrix({ rows, residual, onOpen }: { rows: RiskRow[]; residual: boolean; onOpen: (id: string) => void }) {
  const t = useT()
  const cells = matrixCells(rows, residual)
  const severities = [1, 2, 3, 4]
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: `auto repeat(${severities.length}, minmax(120px, 1fr))`, gap: 0.5, p: 2, bgcolor: 'background.paper' }}>
      {[3, 2, 1].map((l) => [
        <Box key={`l${l}`} sx={{ alignSelf: 'center', pr: 1, fontWeight: 600 }}>{`${t('Likelihood')} ${l}`}</Box>,
        ...severities.map((s) => {
          const items = cells.get(`${l}:${s}`) ?? []
          return (
            <Box
              key={`${l}:${s}`}
              data-testid={`cell-${l}:${s}`}
              sx={(th) => ({ minHeight: 84, p: 0.5, display: 'flex', flexWrap: 'wrap', gap: 0.5, alignContent: 'flex-start', borderRadius: 1, bgcolor: alpha(bandMain(th, band(l * s)), 0.2) })}
            >
              {items.map((r) => {
                const c = residual ? r.residual_criticity : r.criticity
                return (
                  <Chip
                    key={r.id}
                    size="small"
                    color={band(c) ? BAND_COLOR[band(c)!] : 'default'}
                    label={c ?? '—'}
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
