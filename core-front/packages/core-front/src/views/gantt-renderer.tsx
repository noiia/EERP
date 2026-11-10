'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Collapse from '@mui/material/Collapse'
import Stack from '@mui/material/Stack'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import { erpPath } from '../navigation'
import { usePermission } from '../auth/Can'
import { serializeError, toApiError, type SerializedError } from '../api/errors'
import { mergeListOptions, type EntityListOptions } from '../api/list-options'
import { useT } from '../i18n/translate'
import type { ViewDescriptor } from './descriptor'
import { ErrorAlert } from './error-alert'
import { orderedFields } from './layout-fields'
import { useRelationOps } from './relation-ops'
import type { EntityActions, HasId } from './stores'
import { useOptimisticFieldMove } from './use-optimistic-field-move'

// Gantt display mode: one row per record, a bar from its start date field to
// its end date field on a Day / Week / Month timeline. With `serverOptions`
// (TreeRenderer's server-paged mode) it loads only the records overlapping the
// visible range (`lt[start] = range end`, `gte[end] = range start`), paging
// until a short page, plus the records missing either date (`empty[]`) for
// the Unscheduled panel. Dragging a bar shifts both dates by whole days, its
// edge handles move one date; the write goes through the same optimistic
// hook Kanban and Calendar use. Pointer events only: no keyboard drag (v1).

type Zoom = 'day' | 'week' | 'month'

const DAY_MS = 86_400_000
/** Rows per request while paging the visible range. */
const GANTT_PAGE_SIZE = 200
/** Paging stops past this many records; a caption says the range holds more. */
const GANTT_RECORD_CAP = 1000
/** Unscheduled records loaded per missing date field. */
const GANTT_UNSCHEDULED_LIMIT = 50

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

function monday(d: Date): Date {
  return addDays(d, -((d.getDay() + 6) % 7))
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Local whole-day difference (rounded: a DST day is 23 or 25 hours). */
function dayDiff(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / DAY_MS)
}

/** Visible range [start, end) and its header columns for a zoom level. */
function viewRange(zoom: Zoom, anchor: Date) {
  if (zoom === 'month') {
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
    const columns = Array.from({ length: 6 }, (_, i) => new Date(start.getFullYear(), start.getMonth() + i, 1))
    return { start, end: new Date(start.getFullYear(), start.getMonth() + 6, 1), columns }
  }
  const start = monday(anchor)
  const [count, step] = zoom === 'day' ? [14, 1] : [12, 7]
  const columns = Array.from({ length: count }, (_, i) => addDays(start, i * step))
  return { start, end: addDays(start, count * step), columns }
}

function shiftAnchor(zoom: Zoom, anchor: Date, dir: number): Date {
  if (zoom === 'month') return new Date(anchor.getFullYear(), anchor.getMonth() + 6 * dir, 1)
  return addDays(anchor, (zoom === 'day' ? 14 : 84) * dir)
}

function columnLabel(zoom: Zoom, d: Date): string {
  if (zoom === 'month') return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
  if (zoom === 'day') return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** The local day a field value falls on, or null when unset/unparsable. A
 * plain date reads its 'YYYY-MM-DD' prefix (never `new Date(...)`, which
 * parses it as UTC midnight); a datetime is an instant, read in local time. */
function dayOf(raw: unknown, datetime: boolean): Date | null {
  if (typeof raw !== 'string' || raw === '') return null
  if (datetime) {
    const d = new Date(raw)
    return Number.isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate())
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

/** A value moved by whole days, written back in the field's own format: a
 * datetime keeps its local time of day (UTC ISO, like the datetime widget),
 * a plain date stays 'YYYY-MM-DD' (like the date widget). */
function shiftValue(raw: string, days: number, datetime: boolean): string {
  if (datetime) {
    const d = new Date(raw)
    d.setDate(d.getDate() + days)
    return d.toISOString()
  }
  return isoDate(addDays(dayOf(raw, false)!, days))
}

/** The tighter of a search-bar bound and the range's own bound. */
const minBound = (user: string | undefined, ours: string) => (user && user < ours ? user : ours)
const maxBound = (user: string | undefined, ours: string) => (user && user > ours ? user : ours)

type DragMode = 'move' | 'start' | 'end'
interface Drag {
  id: string
  mode: DragMode
  originX: number
  pxPerDay: number
  delta: number
  moved: boolean
}

export interface GanttRendererProps<T extends HasId> {
  descriptor: ViewDescriptor<T>
  initialData: T[]
  actions: EntityActions<T>
  /** The entity's Gantt start and end date fields ('date' fields). */
  startField: string
  endField: string
  /** Reports the working record set up to TreeRenderer (see CalendarRenderer). */
  onRecordsChange?: (records: T[]) => void
  /** Set ⇒ fetch the visible range + unscheduled records from the server. */
  serverOptions?: EntityListOptions
}

export function GanttRenderer<T extends HasId>({
  descriptor,
  initialData,
  actions,
  startField,
  endField,
  onRecordsChange,
  serverOptions,
}: GanttRendererProps<T>) {
  const t = useT()
  const router = useRouter()
  const relationOps = useRelationOps()
  const canWrite = usePermission(`${descriptor.entity}:${descriptor.entity}:write`)
  const { formPath } = descriptor
  const [zoom, setZoom] = useState<Zoom>('week')
  const [anchor, setAnchor] = useState(() => new Date())
  const range = viewRange(zoom, anchor)
  const totalDays = dayDiff(range.end, range.start)
  const fromIso = isoDate(range.start)
  const untilIso = isoDate(range.end)

  const isDatetime = (name: string) => descriptor.fields.find((f) => f.name === name)?.widget === 'datetime'
  const startDatetime = isDatetime(startField)
  const endDatetime = isDatetime(endField)

  const [server, setServer] = useState<{ records: T[]; capped: boolean } | null>(null)
  const [loadError, setLoadError] = useState<SerializedError | null>(null)
  const serverKey = serverOptions && relationOps?.listPage ? JSON.stringify(serverOptions) : null
  useEffect(() => {
    const listPage = relationOps?.listPage
    if (serverKey == null || !listPage) {
      setServer(null)
      return
    }
    const opts = JSON.parse(serverKey) as EntityListOptions
    const scoped: EntityListOptions = {
      ...mergeListOptions(opts, {
        lt: { [startField]: minBound(opts.lt?.[startField], untilIso) },
        gte: { [endField]: maxBound(opts.gte?.[endField], fromIso) },
      }),
      order: startField,
      pageSize: GANTT_PAGE_SIZE,
    }
    let cancelled = false
    // Page until a short page — an estimated total (ADR-032) never bounds the loop.
    const loadRange = async () => {
      const rows: unknown[] = []
      for (let page = 1; ; page++) {
        const res = await listPage(descriptor.entity, { ...scoped, page })
        rows.push(...res.records)
        if (res.records.length < GANTT_PAGE_SIZE) return { rows, capped: false }
        if (rows.length >= GANTT_RECORD_CAP) {
          // One probe row past the cap: exactly GANTT_RECORD_CAP matches isn't "more".
          const probe = await listPage(descriptor.entity, { ...scoped, page: GANTT_RECORD_CAP + 1, pageSize: 1 })
          return { rows, capped: probe.records.length > 0 }
        }
      }
    }
    const unscheduled = (field: string) =>
      listPage(descriptor.entity, { ...mergeListOptions(opts, { empty: [field] }), pageSize: GANTT_UNSCHEDULED_LIMIT })
    void Promise.all([loadRange(), unscheduled(startField), unscheduled(endField)])
      .then(([inRange, noStart, noEnd]) => {
        if (cancelled) return
        const byId = new Map<string, T>()
        for (const r of [...inRange.rows, ...noStart.records, ...noEnd.records] as T[]) byId.set(r.id, r)
        setLoadError(null)
        setServer({ records: [...byId.values()], capped: inRange.capped })
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(serializeError(toApiError(e)))
      })
    return () => {
      cancelled = true
    }
  }, [serverKey, fromIso, untilIso, startField, endField, descriptor.entity])

  const { records, error, moveFields } = useOptimisticFieldMove(server?.records ?? initialData, actions, startField)
  useEffect(() => {
    onRecordsChange?.(records)
  }, [records, onRecordsChange])

  const [labelField] = orderedFields(descriptor, { exclude: [startField, endField], limit: 1 })
  const label = (record: T) =>
    labelField ? String((record as Record<string, unknown>)[labelField.name] ?? record.id) : record.id
  const openForm = (record: T) => {
    if (formPath) router.push(erpPath(formPath.replace(':id', record.id)))
  }

  // Each record's [start, end] as day indexes from the range start.
  const rows: { record: T; s: number; e: number }[] = []
  const unscheduled: T[] = []
  for (const record of records) {
    const values = record as Record<string, unknown>
    const s = dayOf(values[startField], startDatetime)
    const e = dayOf(values[endField], endDatetime)
    if (!s || !e) {
      unscheduled.push(record)
      continue
    }
    const si = dayDiff(s, range.start)
    const ei = Math.max(si, dayDiff(e, range.start))
    if (si < totalDays && ei >= 0) rows.push({ record, s: si, e: ei })
  }
  rows.sort((a, b) => a.s - b.s || a.e - b.e)

  const trackRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)

  /** The drag's whole-day delta, clamped so the end never precedes the start. */
  function clampedDelta(d: Drag, s: number, e: number): number {
    if (d.mode === 'start') return Math.min(d.delta, e - s)
    if (d.mode === 'end') return Math.max(d.delta, s - e)
    return d.delta
  }

  function startDrag(event: React.PointerEvent, id: string, mode: DragMode) {
    event.preventDefault()
    event.stopPropagation()
    const width = trackRef.current?.getBoundingClientRect().width ?? 0
    const next = { id, mode, originX: event.clientX, pxPerDay: width / totalDays, delta: 0, moved: false }
    dragRef.current = next
    setDrag(next)
  }

  function finishDrag() {
    const d = dragRef.current
    dragRef.current = null
    setDrag(null)
    if (!d) return
    const row = rows.find((r) => r.record.id === d.id)
    if (!row) return
    const delta = clampedDelta(d, row.s, row.e)
    if (delta === 0) {
      if (d.mode === 'move' && !d.moved) openForm(row.record)
      return
    }
    const values = row.record as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    if (d.mode !== 'end') patch[startField] = shiftValue(String(values[startField]), delta, startDatetime)
    if (d.mode !== 'start') patch[endField] = shiftValue(String(values[endField]), delta, endDatetime)
    // Day-level clamping can still invert two instants on the same day: keep end >= start.
    if (startDatetime && endDatetime) {
      const s = String(patch[startField] ?? values[startField])
      const e = String(patch[endField] ?? values[endField])
      if (Date.parse(e) < Date.parse(s)) {
        if (d.mode === 'start') patch[startField] = e
        else patch[endField] = s
      }
    }
    void moveFields(d.id, patch)
  }
  const finishRef = useRef(finishDrag)
  finishRef.current = finishDrag

  const dragging = drag != null
  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const dx = e.clientX - d.originX
      const next = {
        ...d,
        delta: d.pxPerDay > 0 ? Math.round(dx / d.pxPerDay) : 0,
        moved: d.moved || Math.abs(dx) > 3,
      }
      dragRef.current = next
      setDrag(next)
    }
    const onUp = () => finishRef.current()
    // A cancelled pointer (scroll takeover, lost touch) drops the drag: no write.
    const onCancel = () => {
      dragRef.current = null
      setDrag(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [dragging])

  const pct = (days: number) => `${(days / totalDays) * 100}%`
  const handleSx = { position: 'absolute', top: 0, bottom: 0, width: 8, cursor: 'ew-resize', touchAction: 'none' } as const

  function bar({ record, s, e }: { record: T; s: number; e: number }) {
    let [bs, be] = [s, e]
    if (drag?.id === record.id) {
      const delta = clampedDelta(drag, s, e)
      if (drag.mode !== 'end') bs += delta
      if (drag.mode !== 'start') be += delta
    }
    const left = Math.max(bs, 0)
    const right = Math.min(be + 1, totalDays)
    if (right <= left) return null
    return (
      <Box
        data-testid={`gantt-bar-${record.id}`}
        title={label(record)}
        onPointerDown={canWrite ? (ev) => startDrag(ev, record.id, 'move') : undefined}
        onClick={canWrite ? undefined : () => openForm(record)}
        sx={{
          position: 'absolute',
          top: 4,
          bottom: 4,
          bgcolor: 'primary.main',
          borderRadius: 1,
          cursor: canWrite ? 'grab' : formPath ? 'pointer' : 'default',
          touchAction: 'none',
          opacity: drag?.id === record.id ? 0.8 : 1,
        }}
        style={{ left: pct(left), width: pct(right - left) }}
      >
        {canWrite ? (
          <>
            <Box
              data-testid={`gantt-handle-start-${record.id}`}
              onPointerDown={(ev) => startDrag(ev, record.id, 'start')}
              sx={{ ...handleSx, left: 0 }}
            />
            <Box
              data-testid={`gantt-handle-end-${record.id}`}
              onPointerDown={(ev) => startDrag(ev, record.id, 'end')}
              sx={{ ...handleSx, right: 0 }}
            />
          </>
        ) : null}
      </Box>
    )
  }

  return (
    <Box>
      <ErrorAlert error={error} />
      <ErrorAlert error={loadError} />
      <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mb: 1 }}>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={zoom}
              onChange={(_e, next: Zoom | null) => {
                if (next) setZoom(next)
              }}
              aria-label={t('Zoom')}
            >
              <ToggleButton value="day">{t('Day')}</ToggleButton>
              <ToggleButton value="week">{t('Week')}</ToggleButton>
              <ToggleButton value="month">{t('Month')}</ToggleButton>
            </ToggleButtonGroup>
            <Button size="small" aria-label={t('Previous period')} onClick={() => setAnchor((a) => shiftAnchor(zoom, a, -1))}>
              {t('Previous')}
            </Button>
            <Button size="small" onClick={() => setAnchor(new Date())}>
              {t('Today')}
            </Button>
            <Button size="small" aria-label={t('Next period')} onClick={() => setAnchor((a) => shiftAnchor(zoom, a, 1))}>
              {t('Next')}
            </Button>
            <Typography variant="subtitle2">
              {range.start.toLocaleDateString()} – {addDays(range.end, -1).toLocaleDateString()}
            </Typography>
            {server?.capped ? (
              <Typography variant="caption" color="text.secondary">
                {GANTT_RECORD_CAP} {t('records shown — narrow the range or the filters to see the rest')}
              </Typography>
            ) : null}
          </Box>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(96px, 200px) minmax(0, 1fr)', rowGap: 0.5 }}>
            <Box />
            <Box ref={trackRef} data-testid="gantt-track" sx={{ position: 'relative', height: 24 }}>
              {range.columns.map((c) => (
                <Typography
                  key={c.getTime()}
                  variant="caption"
                  color="text.secondary"
                  noWrap
                  sx={{ position: 'absolute', top: 0, pl: 0.5 }}
                  style={{ left: pct(dayDiff(c, range.start)) }}
                >
                  {columnLabel(zoom, c)}
                </Typography>
              ))}
            </Box>
            {rows.map((row) => (
              <Box key={row.record.id} data-testid={`gantt-row-${row.record.id}`} sx={{ display: 'contents' }}>
                <Button
                  size="small"
                  onClick={() => openForm(row.record)}
                  sx={{ justifyContent: 'flex-start', textTransform: 'none', minWidth: 0, overflow: 'hidden' }}
                >
                  <Typography variant="body2" noWrap>
                    {label(row.record)}
                  </Typography>
                </Button>
                <Box sx={{ position: 'relative', height: 32, bgcolor: 'action.hover', borderRadius: 1 }}>
                  {bar(row)}
                </Box>
              </Box>
            ))}
          </Box>
        </Box>

        <Collapse in={unscheduled.length > 0} orientation="horizontal" unmountOnExit>
          <Box
            role="group"
            aria-label={t('Unscheduled')}
            sx={{ width: 220, flexShrink: 0, bgcolor: 'action.hover', borderRadius: 1, p: 1 }}
          >
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              {t('Unscheduled')} ({unscheduled.length})
            </Typography>
            <Stack spacing={0.5}>
              {unscheduled.map((record) => (
                <Card
                  key={record.id}
                  className="erp-appear"
                  variant="outlined"
                  onClick={formPath ? () => openForm(record) : undefined}
                  sx={{ cursor: formPath ? 'pointer' : 'default' }}
                >
                  <CardContent sx={{ p: 1, '&:last-child': { pb: 1 } }}>
                    <Typography variant="caption">{label(record)}</Typography>
                  </CardContent>
                </Card>
              ))}
            </Stack>
          </Box>
        </Collapse>
      </Stack>
    </Box>
  )
}
