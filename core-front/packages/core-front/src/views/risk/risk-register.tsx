'use client'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import { useT } from '../../i18n/translate'
import type { FieldDescriptor } from '../descriptor'
import { useRelationLabels } from '../use-relation-labels'
import type { RiskRow } from './scoring'

// Only responsible_id is resolved here (categories come from the renderer's own read).
const USER_FIELD = { name: 'responsible_id', type: 'relation', relation: { entity: 'users', kind: 'many2one', labelField: 'display_name' } } as unknown as FieldDescriptor

const dash = (v: unknown) => (v == null || v === '' ? '—' : String(v))

export function RiskRegister({ rows, categories, onOpen }: {
  rows: RiskRow[]
  categories: { id: string; name: string }[]
  onOpen: (id: string) => void
}) {
  const t = useT()
  const label = useRelationLabels([USER_FIELD], rows.map((r) => ['responsible_id', r.responsible_id]))
  const cat = new Map(categories.map((c) => [c.id, c.name]))
  const impact: Record<string, string> = { delay: t('Delay'), cost: t('Cost'), quality: t('Quality') }
  const heads = ['Risk', 'Category', 'Impact on', 'Likelihood', 'Severity', 'Detectability', 'Criticity', 'Remediation', 'Responsible', 'Deadline', 'Residual criticity']
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
