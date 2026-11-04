'use client'
import { useState } from 'react'
import { styled, type SxProps, type Theme } from '@mui/material/styles'
import Box from '@mui/material/Box'
import Link from '@mui/material/Link'
import MenuItem from '@mui/material/MenuItem'
import Pagination from '@mui/material/Pagination'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import { useT } from '@eerp/core-front'
import { rowsPx } from '../layout-ops'
import { pictureUrl } from '../urls'
import type { PresentedFields } from '../present'
import type { RecordListConfig } from '../types'
import { FieldValue, VISUALLY_HIDDEN } from './FieldValue'
import { hasPicture, label } from './fields'
import { RecordCard } from './RecordCard'

const Table = styled('table')({})

// One container query per field column, hiding column i once the block is
// narrower than (i + 2) × 160px. Typed explicitly: inferred inline inside sx,
// the computed keys make a union TypeScript 7 refuses as "too complex".
function hideColumns(n: number): Record<string, SxProps<Theme>> {
  const rules: Record<string, SxProps<Theme>> = {}
  for (let i = 0; i < n; i++) rules[`@container (max-width: ${(i + 2) * 160}px)`] = { [`& .col-${i}`]: { display: 'none' } }
  return rules
}
const tableSx: SxProps<Theme> = {
  width: '100%', borderCollapse: 'collapse',
  '& th, & td': { p: 1.25, textAlign: 'left', borderBottom: 1, borderColor: 'divider', verticalAlign: 'middle' },
  '& th': { typography: 'caption', fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em' },
  '& tbody tr:hover': { bgcolor: 'action.hover' },
}

const SIZES = [10, 25, 50]

/** Visitor-facing record list: grid/list toggle, page size, pagination. `h` is the
 * block's height in grid rows: the grid scrolls inside it instead of growing the page. */
export function RecordList({ config, records, presented, h }: { config: RecordListConfig; records: Record<string, unknown>[]; presented: PresentedFields; h: number }) {
  const t = useT()
  const sizes = [...new Set([...SIZES, config.page_size ?? 10])].sort((a, b) => a - b)
  const [view, setView] = useState(config.display ?? 'grid')
  const [size, setSize] = useState(config.page_size ?? 10)
  const [page, setPage] = useState(1)
  const shown = records.slice((page - 1) * size, page * size)
  const pages = Math.ceil(records.length / size)
  const href = (id: string) => config.detail_slug ? `/${encodeURIComponent(config.detail_slug)}/${encodeURIComponent(id)}` : undefined
  const cols = presented.columns
  const pic = config.picture_field

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end', alignItems: 'center' }}>
        <TextField select size="small" label={t('Per page')} value={size} sx={{ minWidth: 100 }}
          onChange={(e) => { setSize(Number(e.target.value)); setPage(1) }}>
          {sizes.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
        </TextField>
        <ToggleButtonGroup size="small" exclusive value={view} aria-label={t('Display')} onChange={(_, v) => v && setView(v)}>
          <ToggleButton value="grid">{t('Grid')}</ToggleButton>
          <ToggleButton value="list">{t('List')}</ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      {view === 'grid' ? (
        // The block's height in px, minus ~128px for the toolbar and pager.
        <Box sx={{ display: 'grid', gap: 2, overflowY: 'auto', maxHeight: Math.max(rowsPx(h) - 128, 240), p: 1,
          // Columns follow the block's own width, not the viewport: as many 220px+ cards as fit.
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(220px, 100%), 1fr))' }}>
          {shown.map((rec) => <RecordCard key={String(rec.id)} config={config} rec={rec} shown={presented} />)}
        </Box>
      ) : (
        // The table follows the block's own width: field columns drop off right to left as it narrows.
        <Box sx={{ containerType: 'inline-size', overflowX: 'auto', ...hideColumns(cols.length) }}>
          <Table sx={tableSx}>
            <thead>
              <tr>
                {pic && <th />}
                <th>{label(config.title_field)}</th>
                {cols.map((c, i) => <th key={c.name} className={`col-${i}`}>{c.label ?? <Box component="span" sx={VISUALLY_HIDDEN}>{c.spoken}</Box>}</th>)}
              </tr>
            </thead>
            <tbody>
              {shown.map((rec) => {
                const id = String(rec.id)
                const title = String(rec[config.title_field] ?? '')
                return (
                  <tr key={id}>
                    {pic && <td style={{ width: 56 }}>{hasPicture(rec, pic) && <Box component="img" src={pictureUrl(config.table, id, pic)} alt="" loading="lazy" sx={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 1, display: 'block' }} />}</td>}
                    <td>{href(id) ? <Link href={href(id)}>{title}</Link> : title}</td>
                    {cols.map((c, i) => {
                      const v = presented.values[id]?.[c.name]
                      return <td key={c.name} className={`col-${i}`}>{v && <FieldValue column={c} value={v} />}</td>
                    })}
                  </tr>
                )
              })}
            </tbody>
          </Table>
        </Box>
      )}
      {pages > 1 && <Pagination size="small" count={pages} page={page} onChange={(_, p) => setPage(p)} sx={{ alignSelf: 'center' }} />}
    </Stack>
  )
}
