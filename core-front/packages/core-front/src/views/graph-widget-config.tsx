'use client'
import { useEffect, useState } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import { TILE_TYPES, type TileType } from '../api/graph'
import { fieldLabel, type JsonValue, type ViewDescriptor } from './descriptor'
import type { FullAggregate, NumericAggregate } from './graph-aggregate'
import { orderedFields } from './layout-fields'
import { useT } from '../i18n/translate'
import type { HasId } from './stores'

// The "+ Add widget" / "configure a tile" dialog (docs/roadmaps/list-view-modes.md,
// Phase 5) — Phase 4 shipped this as a type-picker-only placeholder; this is
// the real per-type config form the DoD calls for. Field pickers are sourced
// from the entity's OWN descriptor (never free text), so a Tile.config can
// only ever reference fields that actually exist — the same "descriptors are
// the source of truth for what fields exist" discipline the rest of the
// engine follows. Reused for both adding a new tile and re-configuring an
// existing one (`initial` present).

export interface WidgetDraft {
  type: TileType
  title: string
  config: JsonValue
}

const AGGREGATE_OPTIONS: readonly FullAggregate[] = ['sum', 'mean', 'median', 'count']
const BUCKET_OPTIONS = ['day', 'week', 'month'] as const
const XY_AGGREGATE_OPTIONS: readonly NumericAggregate[] = ['sum', 'avg', 'count']
/** Sentinel for pie's optional value field — '' can't be a Select value. */
const NO_VALUE_FIELD = '__count__'
/** Sentinel for xy's optional series field — '' can't be a Select value. */
const NO_SERIES_FIELD = '__single__'

function readString(config: Record<string, unknown>, key: string): string {
  const v = config[key]
  return typeof v === 'string' ? v : ''
}
function readStringArray(config: Record<string, unknown>): string[] {
  const v = config.displayFields
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

export function WidgetConfigDialog<T extends HasId>({
  open,
  descriptor,
  initial,
  onClose,
  onSubmit,
}: {
  open: boolean
  descriptor: ViewDescriptor<T>
  /** Present when re-configuring an existing tile; absent when adding a new one. */
  initial?: WidgetDraft | null
  onClose: () => void
  onSubmit: (draft: WidgetDraft) => void
}) {
  const t = useT()
  const [type, setType] = useState<TileType>('stat')
  const [title, setTitle] = useState('')

  const [xField, setXField] = useState('')
  const [yField, setYField] = useState('')
  const [seriesField, setSeriesField] = useState('')
  const [xyAggregate, setXyAggregate] = useState<NumericAggregate>('sum')
  const [bucket, setBucket] = useState<'day' | 'week' | 'month'>('month')

  const [groupByField, setGroupByField] = useState('')
  const [valueField, setValueField] = useState('')

  const [statField, setStatField] = useState('')
  const [statAggregate, setStatAggregate] = useState<FullAggregate>('count')

  const [filterField, setFilterField] = useState('')
  const [filterValue, setFilterValue] = useState('')
  const [displayFields, setDisplayFields] = useState<string[]>([])

  // (Re)seed local state whenever the dialog opens — from `initial` when
  // configuring an existing tile, or sensible defaults for a new one.
  useEffect(() => {
    if (!open) return
    const seedType = initial?.type ?? 'stat'
    const config = (initial?.config && typeof initial.config === 'object' && !Array.isArray(initial.config)
      ? (initial.config as Record<string, unknown>)
      : {}) as Record<string, unknown>
    setType(seedType)
    setTitle(initial?.title ?? '')
    setXField(readString(config, 'xField'))
    setYField(readString(config, 'yField'))
    setSeriesField(readString(config, 'seriesField'))
    const rawXyAgg = config.aggregate
    setXyAggregate(rawXyAgg === 'avg' || rawXyAgg === 'count' ? rawXyAgg : 'sum')
    const rawBucket = config.bucket
    setBucket(rawBucket === 'day' || rawBucket === 'week' ? rawBucket : 'month')
    setGroupByField(readString(config, 'groupByField'))
    setValueField(readString(config, 'valueField'))
    setStatField(readString(config, 'field'))
    const rawStatAgg = config.aggregate
    setStatAggregate(
      rawStatAgg === 'mean' || rawStatAgg === 'median' || rawStatAgg === 'sum' || rawStatAgg === 'count'
        ? rawStatAgg
        : 'count',
    )
    setFilterField(readString(config, 'filterField'))
    setFilterValue(readString(config, 'filterValue'))
    const seededDisplay = readStringArray(config)
    setDisplayFields(
      seededDisplay.length > 0 ? seededDisplay : orderedFields(descriptor, { limit: 3 }).map((f) => f.name),
    )
  }, [open, initial, descriptor])

  const dateFields = descriptor.fields.filter((f) => f.type === 'date')
  const numberFields = descriptor.fields.filter((f) => f.type === 'number')
  const groupableFields = descriptor.fields.filter(
    (f) => f.type === 'selection' || f.type === 'text' || f.type === 'boolean',
  )
  const fieldsByName = new Map(descriptor.fields.map((f) => [f.name, f]))

  /** The config this draft would produce, or an error message if it's not
   * valid yet — checked live so Add/Save disables instead of failing later,
   * and a mismatched combination (e.g. a text field on a mean stat) surfaces
   * IN the dialog, never silently at render time. */
  function build(): { config: JsonValue } | { error: string } {
    switch (type) {
      case 'xy':
        if (!xField) return { error: t('Pick a date field for X.') }
        if (!yField) return { error: t('Pick a number field for Y.') }
        return {
          config: seriesField
            ? { xField, yField, seriesField, aggregate: xyAggregate, bucket }
            : { xField, yField, aggregate: xyAggregate, bucket },
        }
      case 'pie':
        if (!groupByField) return { error: t('Pick a field to group by.') }
        return valueField
          ? { config: { groupByField, valueField, aggregate: 'sum' } }
          : { config: { groupByField, aggregate: 'count' } }
      case 'stat': {
        if (!statField) return { error: t('Pick a field.') }
        if (statAggregate !== 'count' && fieldsByName.get(statField)?.type !== 'number') {
          return { error: t('Mean, median and sum need a number field.') }
        }
        return { config: { field: statField, aggregate: statAggregate } }
      }
      case 'list':
        if (!filterField) return { error: t('Pick a field to filter on.') }
        if (!filterValue) return { error: t('Enter a value to filter on.') }
        if (displayFields.length === 0) return { error: t('Pick at least one column to display.') }
        return { config: { filterField, filterValue, displayFields } }
    }
  }
  const built = build()

  function reset() {
    setType('stat')
    setTitle('')
  }
  function handleCancel() {
    reset()
    onClose()
  }
  function handleSubmit() {
    if ('error' in built) return
    onSubmit({ type, title: title.trim(), config: built.config })
    reset()
  }

  return (
    <Dialog open={open} onClose={handleCancel} fullWidth maxWidth="xs">
      <DialogTitle>{initial ? t('Configure widget') : t('Add widget')}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <FormControl fullWidth>
            <InputLabel id="graph-widget-type">{t('Widget type')}</InputLabel>
            <Select
              labelId="graph-widget-type"
              label={t('Widget type')}
              value={type}
              onChange={(e) => setType(e.target.value as TileType)}
            >
              {TILE_TYPES.map((candidate) => (
                <MenuItem key={candidate} value={candidate}>
                  {t(candidate)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField label={t('Title')} value={title} onChange={(e) => setTitle(e.target.value)} fullWidth />

          {type === 'xy' ? (
            <>
              <FormControl fullWidth>
                <InputLabel id="graph-xy-x">{t('X field (date)')}</InputLabel>
                <Select
                  labelId="graph-xy-x"
                  label={t('X field (date)')}
                  value={xField}
                  onChange={(e) => setXField(e.target.value)}
                >
                  {dateFields.map((f) => (
                    <MenuItem key={f.name} value={f.name}>
                      {t(fieldLabel(f))}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl fullWidth>
                <InputLabel id="graph-xy-y">{t('Y field (number)')}</InputLabel>
                <Select
                  labelId="graph-xy-y"
                  label={t('Y field (number)')}
                  value={yField}
                  onChange={(e) => setYField(e.target.value)}
                >
                  {numberFields.map((f) => (
                    <MenuItem key={f.name} value={f.name}>
                      {t(fieldLabel(f))}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl fullWidth>
                <InputLabel id="graph-xy-aggregate">{t('Aggregate')}</InputLabel>
                <Select
                  labelId="graph-xy-aggregate"
                  label={t('Aggregate')}
                  value={xyAggregate}
                  onChange={(e) => setXyAggregate(e.target.value as NumericAggregate)}
                >
                  {XY_AGGREGATE_OPTIONS.map((a) => (
                    <MenuItem key={a} value={a}>
                      {t(a)}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl fullWidth>
                <InputLabel id="graph-xy-bucket">{t('Bucket')}</InputLabel>
                <Select
                  labelId="graph-xy-bucket"
                  label={t('Bucket')}
                  value={bucket}
                  onChange={(e) => setBucket(e.target.value as 'day' | 'week' | 'month')}
                >
                  {BUCKET_OPTIONS.map((b) => (
                    <MenuItem key={b} value={b}>
                      {t(b)}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl fullWidth>
                <InputLabel id="graph-xy-series">{t('Series field (optional)')}</InputLabel>
                <Select
                  labelId="graph-xy-series"
                  label={t('Series field (optional)')}
                  value={seriesField || NO_SERIES_FIELD}
                  onChange={(e) => setSeriesField(e.target.value === NO_SERIES_FIELD ? '' : e.target.value)}
                >
                  <MenuItem value={NO_SERIES_FIELD}>{t('None (single line)')}</MenuItem>
                  {groupableFields.map((f) => (
                    <MenuItem key={f.name} value={f.name}>
                      {t(fieldLabel(f))}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </>
          ) : null}

          {type === 'pie' ? (
            <>
              <FormControl fullWidth>
                <InputLabel id="graph-pie-group">{t('Group by field')}</InputLabel>
                <Select
                  labelId="graph-pie-group"
                  label={t('Group by field')}
                  value={groupByField}
                  onChange={(e) => setGroupByField(e.target.value)}
                >
                  {groupableFields.map((f) => (
                    <MenuItem key={f.name} value={f.name}>
                      {t(fieldLabel(f))}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl fullWidth>
                <InputLabel id="graph-pie-value">{t('Value field')}</InputLabel>
                <Select
                  labelId="graph-pie-value"
                  label={t('Value field')}
                  value={valueField || NO_VALUE_FIELD}
                  onChange={(e) => setValueField(e.target.value === NO_VALUE_FIELD ? '' : e.target.value)}
                >
                  <MenuItem value={NO_VALUE_FIELD}>{t('None (count records)')}</MenuItem>
                  {numberFields.map((f) => (
                    <MenuItem key={f.name} value={f.name}>
                      {t(fieldLabel(f))}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </>
          ) : null}

          {type === 'stat' ? (
            <>
              <FormControl fullWidth>
                <InputLabel id="graph-stat-field">{t('Field')}</InputLabel>
                <Select
                  labelId="graph-stat-field"
                  label={t('Field')}
                  value={statField}
                  onChange={(e) => setStatField(e.target.value)}
                >
                  {descriptor.fields.map((f) => (
                    <MenuItem key={f.name} value={f.name}>
                      {t(fieldLabel(f))}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl fullWidth>
                <InputLabel id="graph-stat-aggregate">{t('Aggregate')}</InputLabel>
                <Select
                  labelId="graph-stat-aggregate"
                  label={t('Aggregate')}
                  value={statAggregate}
                  onChange={(e) => setStatAggregate(e.target.value as FullAggregate)}
                >
                  {AGGREGATE_OPTIONS.map((a) => (
                    <MenuItem key={a} value={a}>
                      {t(a)}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </>
          ) : null}

          {type === 'list' ? (
            <>
              <FormControl fullWidth>
                <InputLabel id="graph-list-filter-field">{t('Filter field')}</InputLabel>
                <Select
                  labelId="graph-list-filter-field"
                  label={t('Filter field')}
                  value={filterField}
                  onChange={(e) => setFilterField(e.target.value)}
                >
                  {descriptor.fields.map((f) => (
                    <MenuItem key={f.name} value={f.name}>
                      {t(fieldLabel(f))}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <TextField
                label={t('Filter value')}
                value={filterValue}
                onChange={(e) => setFilterValue(e.target.value)}
                fullWidth
              />
              <FormControl fullWidth>
                <InputLabel id="graph-list-display-fields">{t('Columns to show')}</InputLabel>
                <Select
                  labelId="graph-list-display-fields"
                  label={t('Columns to show')}
                  multiple
                  value={displayFields}
                  onChange={(e) =>
                    setDisplayFields(
                      typeof e.target.value === 'string' ? e.target.value.split(',') : e.target.value,
                    )
                  }
                >
                  {descriptor.fields.map((f) => (
                    <MenuItem key={f.name} value={f.name}>
                      {t(fieldLabel(f))}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            </>
          ) : null}

          {'error' in built ? <Alert severity="warning">{built.error}</Alert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleCancel}>{t('Cancel')}</Button>
        <Button variant="contained" onClick={handleSubmit} disabled={'error' in built}>
          {initial ? t('Save') : t('Add')}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
