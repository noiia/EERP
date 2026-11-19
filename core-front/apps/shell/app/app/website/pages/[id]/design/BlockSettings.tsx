'use client'
import { useEffect, useState, type ReactNode } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import FormGroup from '@mui/material/FormGroup'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { byPrefixAndName, FontAwesomeIcon, useT, ViewBanner } from '@eerp/core-front'
import { savePublished, type PublishedTable } from '@/lib/website-settings'
import { listEditorEvents, listEditorPages } from '@/website/editor-actions'
import type { FieldDisplays } from '@/website/field-display'
import type { Block, FormConfig, SearchConfig } from '@/website/types'
import { FieldDisplayList } from './FieldDisplaySettings'
import { FormSettings } from './FormSettings'
import { InspectorSection } from './Inspector'
import { LinkPicker } from './LinkPicker'
import { RecordPicker } from './RecordPicker'
import { SearchSettings } from './SearchSettings'

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
  const links = bookingKind !== null || block.type === 'record_list' || block.type === 'record_carousel' || block.type === 'image_carousel' || block.type === 'event_list' || block.type === 'search'
  const [pages, setPages] = useState<{ slug: string; title: string; published: boolean }[]>([])
  useEffect(() => {
    if (links) void listEditorPages().then(setPages)
  }, [links])

  /** A titled group of settings (nodes set to false are left out). */
  const sec = (title: string, nodes: ReactNode[], hint?: string) => (
    <InspectorSection key={title} title={t(title)} hint={hint ? t(hint) : undefined}>{nodes}</InspectorSection>
  )
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
  // A link destination (page / Login / Sign up / My account / URL) stored as `<key>` + `<key>_next`.
  const link = (k: string, label: string, nextKey: string) => (
    <LinkPicker key={k} id={id(k)} label={label} href={str(k)} next={str(nextKey)} onChange={(href, next) => set({ [k]: href, [nextKey]: next })} />
  )
  // Where a card click goes: /<slug>/<id>, a page whose record_detail block (record
  // left empty) shows that id. A slug matching no page (typed before this picker) is
  // kept as a flagged option rather than silently dropped.
  const detailSelect = (
    <Stack key="detail_slug" spacing={0.5}>
      <TextField id={id('detail_slug')} select size="small" label={t(block.type === 'event_list' ? 'Event page' : 'Detail page')} value={str('detail_slug')}
        onChange={(e) => set({ detail_slug: e.target.value })}>
        <MenuItem value="">{t('None')}</MenuItem>
        {pages.map((p) => <MenuItem key={p.slug} value={p.slug}>{p.title} (/{p.slug}){p.published ? '' : ` — ${t('not published')}`}</MenuItem>)}
        {str('detail_slug') && !pages.some((p) => p.slug === str('detail_slug')) &&
          <MenuItem value={str('detail_slug')}>{str('detail_slug')} — {t('page not found')}</MenuItem>}
      </TextField>
      <Typography variant="caption" color="text.secondary">
        {block.type === 'event_list'
          ? t('Create a page holding Event booking and Appointment booking blocks left on the event in the URL, publish it, then pick it here.')
          : t('Create a page holding a Record detail block on the same table, its record left empty, publish it, then pick it here.')}
      </Typography>
    </Stack>
  )
  // Changing table resets everything picked from the previous one.
  const tableSelect = (
    <TextField key="table" id={id('table')} select size="small" label={t(block.type === 'section' ? 'Picture from table' : 'Table')} value={str('table')}
      onChange={(e) => set({ table: e.target.value, fields: [], title_field: '', picture_field: '', field: '', filter: {}, record: '', records: [], related: undefined })}>
      {block.type === 'section' && <MenuItem value="">{t('None')}</MenuItem>}
      {tables.map((p) => <MenuItem key={p.table} value={p.table}>{p.table}</MenuItem>)}
    </TextField>
  )
  const num = (k: string, label: string, min: number, max: number) => (
    <TextField key={k} id={id(k)} size="small" type="number" label={t(label)}
      value={typeof c[k] === 'number' ? c[k] : ''} slotProps={{ htmlInput: { min, max } }}
      onChange={(e) => set({ [k]: e.target.value === '' ? undefined : Number(e.target.value) })} />
  )
  const check = (k: string, label: string) => (
    <FormControlLabel key={k} label={t(label)} control={<Checkbox size="small" checked={c[k] === true} onChange={(e) => set({ [k]: e.target.checked })} />} />
  )
  // A record's picture (image, section): field, then the record (empty = the first one holding a picture).
  const pictureSource = str('table') ? [
    select('field', 'Picture field', pictures),
    <RecordPicker key="record" table={str('table')} labelField={fields.find((f) => ['name', 'title', 'display_name'].includes(f)) ?? ''} label="Record (empty = the first one with a picture)"
      value={str('record') ? [str('record')] : []} onChange={(ids) => set({ record: ids[0] ?? '' })} />,
  ] : []
  // Hero content: the hero's own form, and what an image or a section lays over itself.
  const heroContent = [text('title', 'Title'), text('subtitle', 'Subtitle'), text('cta_label', 'Button label'), link('cta_href', 'Button link', 'cta_next')]
  const heroLayout = [
    select('align', 'Horizontal alignment', ['left', 'center', 'right'], { labels: { left: 'Left', center: 'Center', right: 'Right' } }),
    select('valign', 'Vertical alignment', ['top', 'center', 'bottom'], { labels: { top: 'Top', center: 'Center', bottom: 'Bottom' } }),
    select('button_size', 'Button size', ['small', 'medium', 'large'], { labels: { small: 'Small', medium: 'Medium', large: 'Large' } }),
    select('button_width', 'Button width', ['auto', 'full'], { labels: { auto: 'Fit its text', full: 'Full width' } }),
    select('padding', 'Padding', ['none', 'compact', 'normal', 'spacious'], { labels: { none: 'None', compact: 'Compact', normal: 'Normal', spacious: 'Spacious' } })]
  const fieldBoxes = (
    <FormGroup key="fields" aria-label={t('Fields')} sx={FIELD_GRID}>
      {fields.length === 0 && <Typography variant="body2" color="text.secondary" sx={{ gridColumn: '1 / -1' }}>{t('Pick a table first.')}</Typography>}
      {fields.map((f) => (
        <FormControlLabel key={f} label={breakable(f)} control={
          <Checkbox size="small" checked={chosen.includes(f)}
            onChange={(e) => set({ fields: e.target.checked ? [...chosen, f] : chosen.filter((x) => x !== f) })} />
        } />
      ))}
    </FormGroup>
  )
  // The shown fields' display settings (label, format, icon — ADR-036), in their order.
  const fieldDisplay = (
    <Stack key="field-display" spacing={0.5}>
      {chosen.some((f) => f !== str('title_field')) && <Typography variant="body2" sx={{ fontWeight: 600 }}>{t('How each field shows')}</Typography>}
      <FieldDisplayList table={str('table')} fields={chosen.filter((f) => f !== str('title_field'))} columns={fields}
        displays={c.field_display as FieldDisplays | undefined} onChange={(field_display) => set({ field_display })} />
    </Stack>
  )
  const filterRows = () => {
    const rows = Object.entries((c.filter ?? {}) as Record<string, string>)
    const put = (next: [string, string][]) => set({ filter: Object.fromEntries(next) })
    return (
      <Stack key="filter" spacing={1}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>{t('Only rows where')}</Typography>
        {rows.map(([col, v], i) => (
          <Stack key={i} direction="row" spacing={1}>
            <TextField select size="small" label={t('Column')} value={col} sx={{ minWidth: 120 }}
              onChange={(e) => put(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}>
              {fields.map((f) => <MenuItem key={f} value={f}>{f}</MenuItem>)}
            </TextField>
            <TextField size="small" label={t('Value')} value={v}
              onChange={(e) => put(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
            <IconButton size="small" aria-label={t('Remove filter')} onClick={() => put(rows.filter((_, j) => j !== i))} sx={{ alignSelf: 'center' }}>
              <FontAwesomeIcon icon={byPrefixAndName.fas.xmark} />
            </IconButton>
          </Stack>
        ))}
        {/* An object can hold one value per column: offer a new row only while a column is free. */}
        {fields.some((f) => !rows.some(([col]) => col === f)) && (
          <Button size="small" sx={{ alignSelf: 'flex-start' }} startIcon={<FontAwesomeIcon icon={byPrefixAndName.fas.plus} />}
            onClick={() => put([...rows, [fields.find((f) => !rows.some(([col]) => col === f))!, '']])}>
            {t('Add filter')}
          </Button>
        )}
      </Stack>
    )
  }

  // record_detail's related table (e.g. product_variant by product_id): its own table,
  // link column and field pickers, kept under config.related.
  const rel = (c.related ?? {}) as Config
  const relStr = (k: string) => (typeof rel[k] === 'string' ? (rel[k] as string) : '')
  const setRel = (patch: Config) => set({ related: { ...rel, ...patch } })
  const relTable = tables.find((p) => p.table === rel.table)
  const relFields = relTable?.declared ?? []
  const relChosen = Array.isArray(rel.fields) ? (rel.fields as string[]) : []
  const relSelect = (k: string, label: string, options: string[], none = false) => (
    <TextField key={`related-${k}`} id={id(`related-${k}`)} select size="small" label={t(label)} value={relStr(k)} onChange={(e) => setRel({ [k]: e.target.value })}>
      {none && <MenuItem value="">{t('None')}</MenuItem>}
      {options.map((o) => <MenuItem key={o} value={o}>{o}</MenuItem>)}
    </TextField>
  )
  const relatedForm = (
    <InspectorSection key="related" title={t('Related records picker')} hint={t('Optional: rows of another table linked to this record, e.g. product variants.')}>
      <TextField id={id('related-table')} select size="small" label={t('Related table')} value={relStr('table')}
        // A new table: guess the link column `<detail table>_id` when it has one.
        onChange={(e) => {
          const next = tables.find((p) => p.table === e.target.value)
          const guess = `${str('table')}_id`
          set({ related: e.target.value ? { table: e.target.value, link_field: next?.declared.includes(guess) ? guess : '', fields: [], title_field: '', picture_field: '' } : undefined })
        }}>
        <MenuItem value="">{t('None')}</MenuItem>
        {tables.map((p) => <MenuItem key={p.table} value={p.table}>{p.table}</MenuItem>)}
      </TextField>
      {relTable && <>
        {relSelect('link_field', 'Column holding the record id', relFields)}
        {relSelect('title_field', 'Related title field', relFields)}
        {relSelect('picture_field', 'Related picture field', relTable.pictures ?? [], true)}
        <Typography variant="body2" sx={{ fontWeight: 600 }}>{t('Related fields')}</Typography>
        <FormGroup aria-label={t('Related fields')} sx={FIELD_GRID}>
          {relFields.map((f) => (
            <FormControlLabel key={f} label={breakable(f)} control={
              <Checkbox size="small" checked={relChosen.includes(f)}
                onChange={(e) => setRel({ fields: e.target.checked ? [...relChosen, f] : relChosen.filter((x) => x !== f) })} />
            } />
          ))}
        </FormGroup>
        <FieldDisplayList table={relStr('table')} fields={relChosen.filter((f) => f !== relStr('title_field'))} columns={relFields}
          displays={rel.field_display as FieldDisplays | undefined} onChange={(field_display) => setRel({ field_display })} />
        <PublishFields table={relTable} used={[...usedFields(rel), ...(relStr('link_field') ? [relStr('link_field')] : [])]} onPublished={onPublished} />
      </>}
    </InspectorSection>
  )

  const pickRecords = str('table') && <RecordPicker key="records" multiple table={str('table')} labelField={str('title_field')} label="Records (empty = the first ones)"
    value={Array.isArray(c.records) ? (c.records as string[]) : []} onChange={(ids) => set({ records: ids })} />

  let form: ReactNode[]
  switch (block.type) {
    case 'text':
      form = [sec('Content', [text('heading', 'Heading'), text('body', 'Body', { multiline: true }),
        select('align', 'Alignment', ['left', 'center', 'right'], { none: true, labels: { left: 'Left', center: 'Center', right: 'Right' } })],
      'Leave an empty line between paragraphs.')]
      break
    case 'hero':
      form = [sec('Content', heroContent), sec('Layout', heroLayout)]
      break
    case 'image':
      form = [
        sec('Picture', [tableSelect, ...pictureSource, text('alt', 'Alternative text'),
          select('fit', 'Picture fit', ['cover', 'contain'], { labels: { cover: 'Fill the block (crop)', contain: 'Whole picture' } })]),
        sec('Link', [link('href', 'Link (without a button)', 'href_next')]),
        sec('Text and button', heroContent, 'Optional: shown over the picture.'),
        sec('Layout', heroLayout),
      ]
      break
    case 'form':
      form = [<FormSettings key="form" blockId={block.id} config={c as unknown as FormConfig} onChange={(next) => onChange(next as unknown as Config)} />]
      break
    case 'section':
      form = [
        sec('Background', [
          <Stack key="color" direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <TextField id={id('color')} size="small" type="color" label={t('Background color')} value={str('color') || '#ffffff'}
              onChange={(e) => set({ color: e.target.value })} sx={{ width: 140 }} />
            {str('color') && <Button size="small" onClick={() => set({ color: '' })}>{t('No color')}</Button>}
          </Stack>,
          tableSelect, ...pictureSource,
          str('table') && check('parallax', 'Parallax (picture stays fixed while scrolling)'),
          str('table') && num('dim', 'Darken the picture (%)', 0, 80),
        ], 'Blocks placed over this section are drawn on top of it.'),
        sec('Text and button', heroContent, 'Optional: shown on the section itself.'),
        sec('Layout', heroLayout),
      ]
      break
    case 'record_list':
      form = [
        sec('Data', [tableSelect, filterRows()]),
        sec('Card', [fieldBoxes, select('title_field', 'Title field', fields), select('picture_field', 'Picture field', pictures, { none: true }), fieldDisplay], 'Fields shown on each record.'),
        sec('Display', [select('display', 'Display', ['grid', 'list'], { labels: { grid: 'Grid', list: 'List' } }), num('page_size', 'Records per page', 1, 100)],
          'The default view: visitors can switch between grid and list.'),
        sec('Link', [detailSelect]),
      ]
      break
    case 'record_detail':
      form = [
        sec('Data', [tableSelect,
          str('table') && <RecordPicker key="record" table={str('table')} labelField={str('title_field')} label="Record (empty = the one in the URL)"
            value={str('record') ? [str('record')] : []} onChange={(ids) => set({ record: ids[0] ?? '' })} />]),
        sec('Content', [fieldBoxes, select('title_field', 'Title field', fields), select('picture_field', 'Picture field', pictures, { none: true }), fieldDisplay]),
        relatedForm,
      ]
      break
    case 'record_carousel':
      form = [
        sec('Data', [tableSelect, pickRecords, num('limit', 'Maximum number of records', 1, 100)]),
        sec('Card', [fieldBoxes, select('title_field', 'Title field', fields), select('picture_field', 'Picture field', pictures, { none: true }),
          select('picture_position', 'Picture position', ['top', 'left', 'right'], { labels: { top: 'Top', left: 'Left', right: 'Right' } }),
          num('picture_width', 'Picture width beside the text (%)', 10, 90), num('card_width', 'Card width (px)', 160, 1200), fieldDisplay]),
        sec('Link', [detailSelect]),
      ]
      break
    case 'image_carousel':
      form = [
        sec('Data', [tableSelect, pickRecords, num('limit', 'Maximum number of records', 1, 100), filterRows()]),
        sec('Picture', [select('picture_field', 'Picture field', pictures), select('title_field', 'Caption field', fields, { none: true })]),
        sec('Link', [detailSelect]),
      ]
      break
    case 'event_booking':
    case 'appointment_booking':
      form = [
        sec('Event', [
          <TextField key="event_id" id={id('event_id')} select size="small" label={t('Event')} value={str('event_id')}
            onChange={(e) => set({ event_id: e.target.value })}>
            <MenuItem value="">{t('The event in the URL')}</MenuItem>
            {events.map((ev) => <MenuItem key={ev.id} value={ev.id}>{ev.name}</MenuItem>)}
          </TextField>,
          <Typography key="hint" variant="caption" color="text.secondary">
            {t('The block shows once the event is published.')}
            {!str('event_id') && <> {t('Left on the event in the URL, this page can serve every event: pick it as the Event page of an Event list block.')}</>}
          </Typography>,
        ]),
        sec('Access', [
          <FormControlLabel key="login_required" label={t('Login required')}
            control={<Switch size="small" checked={c.login_required === true} onChange={(e) => set({ login_required: e.target.checked })} />} />,
          c.login_required === true && <TextField key="after_login_slug" id={id('after_login_slug')} select size="small" label={t('After login, go to')}
            value={str('after_login_slug')} onChange={(e) => set({ after_login_slug: e.target.value })}>
            <MenuItem value="">{t('This page')}</MenuItem>
            {pages.map((p) => <MenuItem key={p.slug} value={p.slug}>{p.title} (/{p.slug}){p.published ? '' : ` — ${t('not published')}`}</MenuItem>)}
            {str('after_login_slug') && !pages.some((p) => p.slug === str('after_login_slug')) &&
              <MenuItem value={str('after_login_slug')}>{str('after_login_slug')} — {t('page not found')}</MenuItem>}
          </TextField>,
        ]),
      ]
      break
    case 'event_list':
      form = [
        sec('Display', [
          select('display', 'Display', ['cards', 'list'], { labels: { cards: 'Cards', list: 'List' } }),
          num('limit', 'Maximum number of events', 1, 50),
          check('nearest', "Nearest to me (asks the visitor's location)"),
          ...(c.nearest === true ? [
            <Typography key="nearest-hint" variant="caption" color="text.secondary">
              {t("Distances need the event table's map position (geo_location) published under Settings → Website → Published data.")}
            </Typography>,
          ] : []),
        ], 'Lists published events with a future session (appointment events too), soonest first — or nearest first when the visitor shares their location.'),
        sec('Link', [detailSelect]),
      ]
      break
    case 'search':
      form = [<SearchSettings key="search" blockId={block.id} config={c as unknown as SearchConfig} tables={tables} pages={pages}
        onChange={(next) => onChange(next as unknown as Config)}
        renderPublish={(table, used) => <PublishFields table={table} used={used} onPublished={onPublished} />} />]
      break
    default:
      form = []
  }

  return (
    <Stack spacing={2}>
      {form}
      {current && <PublishFields table={current} used={usedFields(c)} onPublished={onPublished} />}
      <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 2 }}>
        <Button color="error" fullWidth onClick={onDelete} startIcon={<FontAwesomeIcon icon={byPrefixAndName.fas.trash} />}>{t('Delete block')}</Button>
      </Box>
    </Stack>
  )
}

/** Field checkboxes in two columns: a panel-width list of column names stays scannable. */
const FIELD_GRID = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', columnGap: 1, '& .MuiFormControlLabel-label': { overflowWrap: 'anywhere', fontSize: '0.8125rem', lineHeight: 1.3 } } as const

/** A column name that may wrap after its underscores (`booking_horizon_days`), never mid-word. */
const breakable = (name: string) => name.split('_').flatMap((part, i) => (i ? [<wbr key={i} />, `_${part}`] : [part]))

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
export function PublishFields({ table, used, onPublished }: {
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
    <ViewBanner status="warning" action={
      <Button color="inherit" size="small" disabled={state.busy} onClick={() => void publish()}>{t('Publish')}</Button>
    }>
      {t('Not public yet — the website shows nothing for these fields:')} {missing.join(', ')}
      {state.error && <><br />{state.error}</>}
    </ViewBanner>
  )
}
