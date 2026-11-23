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
import { alpha } from '@mui/material/styles'
import { band, heatRgb, type RiskRow } from './scoring'
import { bandMain } from './risk-matrix'
import { registerTable } from './register-table'

// The responsible user's label: resolved by the renderer (categories come from its own read).
export const USER_FIELD = { name: 'responsible_id', type: 'relation', relation: { entity: 'users', kind: 'many2one', labelField: 'display_name' } } as unknown as FieldDescriptor

const dash = (v: unknown) => (v == null || v === '' ? '—' : String(v))

// The temperature view's row background: the criticity's heat color, translucent so text reads in both themes.
const heatBg = (r: RiskRow) => {
  const c = heatRgb(r.criticity)
  return c ? alpha(`rgb(${c.join(',')})`, 0.35) : undefined
}

export function RiskRegister({ rows, categories, responsible, onOpen, heat = false }: {
  rows: RiskRow[]
  categories: { id: string; name: string }[]
  /** The responsible user's name (the renderer resolves them once, for the exports too). */
  responsible: (r: RiskRow) => string | undefined
  onOpen: (id: string) => void
  /** Temperature view: each row tinted by its criticity. */
  heat?: boolean
}) {
  const t = useT()
  const phone = usePhone()
  const cat = new Map(categories.map((c) => [c.id, c.name]))
  const table = registerTable(rows, categories, responsible, t)
  if (phone) {
    return (
      <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        {rows.map((r) => (
          <Box component="li" key={r.id}>
            <ButtonBase
              component="div"
              onClick={() => onOpen(r.id)}
              sx={{ width: '100%', minHeight: 40, p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, textAlign: 'left', bgcolor: heat ? heatBg(r) : undefined }}
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
          <TableRow>{table.heads.map((h) => <TableCell key={h}>{h}</TableCell>)}</TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={r.id} hover data-heat={heat ? (heatRgb(r.criticity)?.join(',') ?? '') : undefined} sx={{ cursor: 'pointer', bgcolor: heat ? heatBg(r) : undefined }} onClick={() => onOpen(r.id)}>
              {table.rows[i].map((v, j) => <TableCell key={j}>{dash(v)}</TableCell>)}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  )
}
