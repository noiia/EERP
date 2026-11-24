'use client'
import { useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import Stack from '@mui/material/Stack'
import { alpha } from '@mui/material/styles'
import { useT } from '../../i18n/translate'
import { heatColors, type RiskRow } from './scoring'

// Before a register export: which risks go in it. Every risk is ticked at first; with the temperature
// view on, the colors follow the selection, so its most dangerous risk is always the red one.
export function RegisterExportDialog({ rows, heat, onClose, onExport }: {
  rows: RiskRow[]
  heat: boolean
  onClose: () => void
  onExport: (selected: RiskRow[]) => void
}) {
  const t = useT()
  const [picked, setPicked] = useState(() => new Set(rows.map((r) => r.id)))
  const selected = rows.filter((r) => picked.has(r.id))
  const colors = heatColors(selected.map((r) => r.criticity))
  const color = new Map(selected.map((r, i) => [r.id, colors[i]]))
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p)
      if (!n.delete(id)) n.add(id)
      return n
    })
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t('Risks to export')}</DialogTitle>
      <DialogContent>
        <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
          <Button size="small" onClick={() => setPicked(new Set())}>{t('Clear selection')}</Button>
          <Button size="small" onClick={() => setPicked(new Set(rows.map((r) => r.id)))}>{t('Select all')}</Button>
        </Stack>
        {rows.map((r) => {
          const c = heat ? color.get(r.id) : null
          return (
            <Box key={r.id} data-heat={heat ? (c?.join(',') ?? '') : undefined} sx={{ borderRadius: 1, px: 1, bgcolor: c ? alpha(`rgb(${c.join(',')})`, 0.35) : undefined }}>
              <FormControlLabel
                sx={{ width: '100%', m: 0 }}
                control={<Checkbox checked={picked.has(r.id)} onChange={() => toggle(r.id)} />}
                label={`${r.criticity ?? '—'} - ${r.name}`}
              />
            </Box>
          )
        })}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('Cancel')}</Button>
        <Button variant="contained" disabled={!selected.length} onClick={() => onExport(selected)}>{t('Export')}</Button>
      </DialogActions>
    </Dialog>
  )
}
