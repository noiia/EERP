'use client'
import type { ReactNode } from 'react'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import FormGroup from '@mui/material/FormGroup'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useT } from '@eerp/core-front'
import type { PublishedTable } from '@/lib/website-settings'
import type { Block } from '@/website/types'
import { BLOCK_LABELS } from './BlockPalette'

type Config = Record<string, unknown>

// Per-type block forms. Table and field pickers offer ONLY published data
// (Settings → Website → Published data): a table with no published field is
// unreadable by the public site, so it is not offered at all.
export function BlockSettings({ block, published, onChange, onDelete }: {
  block: Block
  published: PublishedTable[]
  onChange: (config: Config) => void
  onDelete: () => void
}) {
  const t = useT()
  const c = block.config
  const str = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : '')
  const set = (patch: Config) => onChange({ ...c, ...patch })
  const tables = published.filter((p) => p.fields.length > 0)
  const fields = tables.find((p) => p.table === c.table)?.fields ?? []
  const chosen = Array.isArray(c.fields) ? (c.fields as string[]) : []
  const id = (k: string) => `block-${block.id}-${k}`

  const text = (k: string, label: string, extra: { multiline?: boolean; type?: string } = {}) => (
    <TextField key={k} id={id(k)} size="small" label={t(label)} value={str(k)} onChange={(e) => set({ [k]: e.target.value })}
      multiline={extra.multiline} minRows={extra.multiline ? 4 : undefined} type={extra.type} />
  )
  const select = (k: string, label: string, options: string[], opts: { none?: boolean; labels?: Record<string, string> } = {}) => (
    <TextField key={k} id={id(k)} select size="small" label={t(label)} value={str(k)} onChange={(e) => set({ [k]: e.target.value })}>
      {opts.none && <MenuItem value="">{t('None')}</MenuItem>}
      {options.map((o) => <MenuItem key={o} value={o}>{opts.labels ? t(opts.labels[o]) : o}</MenuItem>)}
    </TextField>
  )
  // Changing table resets everything picked from the previous one.
  const tableSelect = (
    <TextField key="table" id={id('table')} select size="small" label={t('Table')} value={str('table')}
      onChange={(e) => set({ table: e.target.value, fields: [], title_field: '', picture_field: '', field: '', filter: {} })}>
      {tables.map((p) => <MenuItem key={p.table} value={p.table}>{p.table}</MenuItem>)}
    </TextField>
  )
  const fieldBoxes = (
    <FormGroup key="fields">
      <Typography variant="subtitle2">{t('Fields')}</Typography>
      {fields.map((f) => (
        <FormControlLabel key={f} label={f} control={
          <Checkbox size="small" checked={chosen.includes(f)}
            onChange={(e) => set({ fields: e.target.checked ? [...chosen, f] : chosen.filter((x) => x !== f) })} />
        } />
      ))}
    </FormGroup>
  )
  const filterRows = () => {
    const rows = Object.entries((c.filter ?? {}) as Record<string, string>)
    const put = (next: [string, string][]) => set({ filter: Object.fromEntries(next) })
    return (
      <Stack key="filter" spacing={1}>
        <Typography variant="subtitle2">{t('Only rows where')}</Typography>
        {rows.map(([col, v], i) => (
          <Stack key={i} direction="row" spacing={1}>
            <TextField select size="small" label={t('Column')} value={col} sx={{ minWidth: 120 }}
              onChange={(e) => put(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}>
              {fields.map((f) => <MenuItem key={f} value={f}>{f}</MenuItem>)}
            </TextField>
            <TextField size="small" label={t('Value')} value={v}
              onChange={(e) => put(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
            <IconButton aria-label={t('Remove filter')} onClick={() => put(rows.filter((_, j) => j !== i))}>×</IconButton>
          </Stack>
        ))}
        {/* An object can hold one value per column: offer a new row only while a column is free. */}
        {fields.some((f) => !rows.some(([col]) => col === f)) && (
          <Button size="small" onClick={() => put([...rows, [fields.find((f) => !rows.some(([col]) => col === f))!, '']])}>
            {t('Add filter')}
          </Button>
        )}
      </Stack>
    )
  }

  let form: ReactNode[]
  switch (block.type) {
    case 'text':
      form = [text('heading', 'Heading'), text('body', 'Body', { multiline: true }),
        select('align', 'Alignment', ['left', 'center', 'right'], { none: true, labels: { left: 'Left', center: 'Center', right: 'Right' } })]
      break
    case 'hero':
      form = [text('title', 'Title'), text('subtitle', 'Subtitle'), text('cta_label', 'Button label'), text('cta_href', 'Button link')]
      break
    case 'image':
      form = [tableSelect, text('record', 'Record id'), select('field', 'Picture field', fields), text('alt', 'Alternative text'), text('href', 'Link')]
      break
    case 'record_list':
      form = [tableSelect, fieldBoxes, select('title_field', 'Title field', fields),
        select('display', 'Display', ['grid', 'list'], { labels: { grid: 'Grid', list: 'List' } }),
        <TextField key="page_size" id={id('page_size')} size="small" type="number" label={t('Records shown')}
          value={typeof c.page_size === 'number' ? c.page_size : ''} slotProps={{ htmlInput: { min: 1, max: 100 } }}
          onChange={(e) => set({ page_size: e.target.value === '' ? undefined : Number(e.target.value) })} />,
        text('detail_slug', 'Detail page slug'), select('picture_field', 'Picture field', fields, { none: true }), filterRows()]
      break
    case 'record_detail':
      form = [tableSelect, fieldBoxes, select('title_field', 'Title field', fields), select('picture_field', 'Picture field', fields, { none: true })]
      break
    default:
      form = [<Typography key="pending" color="text.secondary">{t('Booking will be available soon.')}</Typography>]
  }

  return (
    <Stack spacing={2}>
      <Typography variant="h6">{t(BLOCK_LABELS[block.type])}</Typography>
      {form}
      <Button color="error" variant="outlined" onClick={onDelete}>{t('Delete block')}</Button>
    </Stack>
  )
}
