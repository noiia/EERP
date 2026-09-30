'use client'
import { useEffect, useState, type ReactNode } from 'react'
import Alert from '@mui/material/Alert'
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
import { savePublished, type PublishedTable } from '@/lib/website-settings'
import { listEditorEvents } from '@/website/editor-actions'
import type { Block } from '@/website/types'
import { BLOCK_LABELS } from './BlockPalette'

type Config = Record<string, unknown>

// Per-type block forms. Table and field pickers offer every table a module declares
// public-capable, with its declared fields (ADR-024's ceiling). A field the site can't
// read yet (not published) is flagged, with a button publishing it — the admin's half
// of the two-party act, done from here instead of Settings → Website → Published data.
export function BlockSettings({ block, published, onPublished, onChange, onDelete }: {
  block: Block
  published: PublishedTable[]
  onPublished?: (table: PublishedTable) => void
  onChange: (config: Config) => void
  onDelete: () => void
}) {
  const t = useT()
  const c = block.config
  const str = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : '')
  const set = (patch: Config) => onChange({ ...c, ...patch })
  const tables = published
  const current = tables.find((p) => p.table === c.table)
  const fields = current?.declared ?? []
  const pictures = current?.pictures ?? [] // only fields that can hold a picture
  const chosen = Array.isArray(c.fields) ? (c.fields as string[]) : []
  const id = (k: string) => `block-${block.id}-${k}`
  const bookingKind = block.type === 'event_booking' ? 'sessions' : block.type === 'appointment_booking' ? 'appointment' : null
  const [events, setEvents] = useState<{ id: string; name: string }[]>([])
  useEffect(() => {
    if (bookingKind) void listEditorEvents(bookingKind).then(setEvents)
  }, [bookingKind])

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
      form = [text('title', 'Title'), text('subtitle', 'Subtitle'), text('cta_label', 'Button label'), text('cta_href', 'Button link'),
        select('align', 'Horizontal alignment', ['left', 'center', 'right'], { labels: { left: 'Left', center: 'Center', right: 'Right' } }),
        select('valign', 'Vertical alignment', ['top', 'center', 'bottom'], { labels: { top: 'Top', center: 'Center', bottom: 'Bottom' } }),
        select('button_size', 'Button size', ['small', 'medium', 'large'], { labels: { small: 'Small', medium: 'Medium', large: 'Large' } }),
        select('button_width', 'Button width', ['auto', 'full'], { labels: { auto: 'Fit its text', full: 'Full width' } }),
        select('padding', 'Padding', ['none', 'compact', 'normal', 'spacious'], { labels: { none: 'None', compact: 'Compact', normal: 'Normal', spacious: 'Spacious' } })]
      break
    case 'image':
      form = [tableSelect, text('record', 'Record id'), select('field', 'Picture field', pictures), text('alt', 'Alternative text'), text('href', 'Link')]
      break
    case 'record_list':
      form = [tableSelect, fieldBoxes, select('title_field', 'Title field', fields),
        select('display', 'Display', ['grid', 'list'], { labels: { grid: 'Grid', list: 'List' } }),
        <TextField key="page_size" id={id('page_size')} size="small" type="number" label={t('Records shown')}
          value={typeof c.page_size === 'number' ? c.page_size : ''} slotProps={{ htmlInput: { min: 1, max: 100 } }}
          onChange={(e) => set({ page_size: e.target.value === '' ? undefined : Number(e.target.value) })} />,
        text('detail_slug', 'Detail page slug'), select('picture_field', 'Picture field', pictures, { none: true }), filterRows()]
      break
    case 'record_detail':
      form = [tableSelect, fieldBoxes, select('title_field', 'Title field', fields), select('picture_field', 'Picture field', pictures, { none: true })]
      break
    case 'event_booking':
    case 'appointment_booking':
      form = [
        <TextField key="event_id" id={id('event_id')} select size="small" label={t('Event')} value={str('event_id')}
          onChange={(e) => set({ event_id: e.target.value })}>
          {events.map((ev) => <MenuItem key={ev.id} value={ev.id}>{ev.name}</MenuItem>)}
        </TextField>,
        <Typography key="hint" variant="body2" color="text.secondary">
          {t('The block shows once the event is published.')}
        </Typography>,
      ]
  }

  return (
    <Stack spacing={2}>
      <Typography variant="h6">{t(BLOCK_LABELS[block.type])}</Typography>
      {form}
      {current && <PublishFields table={current} used={usedFields(c)} onPublished={onPublished} />}
      <Button color="error" variant="outlined" onClick={onDelete}>{t('Delete block')}</Button>
    </Stack>
  )
}

/** Every column a block config reads: shown fields, title/picture/image field, filter columns. */
function usedFields(c: Config): string[] {
  const one = (k: string) => (typeof c[k] === 'string' && c[k] ? [c[k] as string] : [])
  const list = Array.isArray(c.fields) ? (c.fields as string[]) : []
  const filter = c.filter && typeof c.filter === 'object' ? Object.keys(c.filter as object) : []
  return [...new Set([...list, ...one('title_field'), ...one('picture_field'), ...one('field'), ...filter])]
}

/** Warns about fields the site can't read yet and publishes them on click (keeps
 * the table's existing published fields and forced filter). Go re-checks the
 * caller's settings:website:write and the module's declared ceiling. */
function PublishFields({ table, used, onPublished }: {
  table: PublishedTable
  used: string[]
  onPublished?: (table: PublishedTable) => void
}) {
  const t = useT()
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
  const missing = used.filter((f) => !table.fields.includes(f))
  if (missing.length === 0) return null
  async function publish() {
    setState({ busy: true, error: null })
    const fields = [...table.fields, ...missing]
    const res = await savePublished(table.table, { fields, filter: table.filter ?? {} })
    if (res.ok) {
      setState({ busy: false, error: null })
      onPublished?.({ ...table, fields })
    } else setState({ busy: false, error: res.message || t('Could not save.') })
  }
  return (
    <Alert severity="warning" action={
      <Button color="inherit" size="small" disabled={state.busy} onClick={() => void publish()}>{t('Publish')}</Button>
    }>
      {t('Not public yet — the website shows nothing for these fields:')} {missing.join(', ')}
      {state.error && <><br />{state.error}</>}
    </Alert>
  )
}
