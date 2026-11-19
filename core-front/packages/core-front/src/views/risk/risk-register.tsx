'use client'
import ButtonBase from '@mui/material/ButtonBase'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import { useT } from '../../i18n/translate'
import type { FieldDescriptor } from '../descriptor'
import { usePhone } from '../use-phone'
import { useRelationLabels } from '../use-relation-labels'
import { band, type RiskRow } from './scoring'
import { bandMain } from './risk-matrix'

// Only responsible_id is resolved here (categories come from the renderer's own read).
const USER_FIELD = { name: 'responsible_id', type: 'relation', relation: { entity: 'users', kind: 'many2one', labelField: 'display_name' } } as unknown as FieldDescriptor

const dash = (v: unknown) => (v == null || v === '' ? '—' : String(v))

export function RiskRegister({ rows, categories, onOpen }: {
  rows: RiskRow[]
  categories: { id: string; name: string }[]
  onOpen: (id: string) => void
}) {
  const t = useT()
  const phone = usePhone()
  const label = useRelationLabels([USER_FIELD], rows.map((r) => ['responsible_id', r.responsible_id]))
  const cat = new Map(categories.map((c) => [c.id, c.name]))
  const impact: Record<string, string> = { delay: t('Delay'), cost: t('Cost'), quality: t('Quality') }
  const heads = ['Risk', 'Category', 'Impact on', 'Likelihood', 'Severity', 'Detectability', 'Criticity', 'Remediation', 'Responsible', 'Deadline', 'Residual criticity']
  if (phone) {
    return (
      <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        {rows.map((r) => (
          <Box component="li" key={r.id}>
            <ButtonBase
              component="div"
              onClick={() => onOpen(r.id)}
              sx={{ width: '100%', minHeight: 40, p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, textAlign: 'left' }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Box sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{r.name}</Box>
                <Box sx={{ color: 'text.secondary', fontSize: 13 }}>{dash(r.category_id && cat.get(r.category_id))}</Box>
              </Box>
              <Chip size="small" label={dash(r.criticity)} sx={(th) => ({ bgcolor: bandMain(th, band(r.criticity)), color: th.palette.getContrastText(bandMain(th, band(r.criticity))) })} />
            </ButtonBase>
          </Box>
        ))}
      </Box>
    )
  }
  return (
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow>{heads.map((h) => <TableCell key={h}>{t(h)}</TableCell>)}</TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id} hover sx={{ cursor: 'pointer' }} onClick={() => onOpen(r.id)}>
              <TableCell>{r.name}</TableCell>
              <TableCell>{dash(r.category_id && cat.get(r.category_id))}</TableCell>
              <TableCell>{impact[r.impact_on] ?? r.impact_on}</TableCell>
              <TableCell>{dash(r.likelihood)}</TableCell>
              <TableCell>{r.severity_note && r.severity_effective == null ? t('Not computable') : dash(r.severity_effective)}</TableCell>
              <TableCell>{dash(r.detectability)}</TableCell>
              <TableCell>{dash(r.criticity)}</TableCell>
              <TableCell>{dash(r.remediation)}</TableCell>
              <TableCell>{dash(r.responsible_id && label('responsible_id', r.responsible_id))}</TableCell>
              <TableCell>{dash(r.deadline && r.deadline.slice(0, 10))}</TableCell>
              <TableCell>{dash(r.residual_criticity)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  )
}
