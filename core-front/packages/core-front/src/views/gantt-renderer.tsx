'use client'
import { useEffect, useId, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Collapse from '@mui/material/Collapse'
import IconButton from '@mui/material/IconButton'
import Popover from '@mui/material/Popover'
import Stack from '@mui/material/Stack'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import { erpPath } from '../navigation'
import { usePermission } from '../auth/Can'
import { serializeError, toApiError, type SerializedError } from '../api/errors'
import { mergeListOptions, type EntityListOptions } from '../api/list-options'
import type { GanttDependenciesConfig } from '../api/view-fields'
import { useT } from '../i18n/translate'
import { useUndoToastStore } from './undo-toast'
import type { ViewDescriptor } from './descriptor'
import { BannerScope, BannerSlot } from './banner'
import { colorStripes } from './color-tags'
import { ErrorAlert } from './error-alert'
import { byPrefixAndName, FontAwesomeIcon } from './icons'
import { orderedFields } from './layout-fields'
import { useRelationOps } from './relation-ops'
import { RelationColorTagsWidget } from './relation-widgets'
import type { EntityActions, HasId } from './stores'
import { useOptimisticFieldMove } from './use-optimistic-field-move'
import { colorTagsFieldOf, useRecordColors } from './use-record-colors'

// Gantt display mode: one row per record, a bar from its start date field to
// its end date field on a Day / Week / Month timeline. With `serverOptions`
// (TreeRenderer's server-paged mode) it loads only the records overlapping the
// visible range (`lt[start] = range end`, `gte[end] = range start`), paging
// until a short page, plus the records missing either date (`empty[]`) for
// the Unscheduled panel. Dragging a bar shifts both dates by whole days, its
// edge handles move one date, an Unscheduled card dropped on a day schedules
// it there; the write goes through the same optimistic hook Kanban and
// Calendar use. Bars also move from the keyboard (arrows, Shift/Alt + arrows
// resize). A today line and, with `dependencies`, link arrows overlay the
// timeline. With `colorTagsField`, a bar is filled with its record's color
// (equal horizontal stripes for several) and a button beside its name edits
// them. Bars carry no text, so no color can make a label unreadable.

type Zoom = 'day' | 'week' | 'month'

const DAY_MS = 86_400_000
/** Rows per request while paging the visible range. */
const GANTT_PAGE_SIZE = 200
/** Paging stops past this many records; a caption says the range holds more. */
const GANTT_RECORD_CAP = 1000
/** Unscheduled records loaded per missing date field. */
const GANTT_UNSCHEDULED_LIMIT = 50
/** Record ids per dependency-link request (`in[toField]`). */
const GANTT_LINK_CHUNK = 100
/** Timeline geometry (px): rows must stay exactly ROW_H tall, the today/arrow overlay is drawn from it. */
const HEADER_H = 24
const ROW_H = 32
const ROW_GAP = 4

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

/** 'place' drags an Unscheduled card onto the timeline. */
type DragMode = 'move' | 'start' | 'end' | 'place'
interface Drag {
  id: string
  mode: DragMode
  originX: number
  originY: number
  /** Last pointer position. */
  x: number
  y: number
  pxPerDay: number
  /** The track's left edge at drag start: places the drop-day highlight. */
  trackLeft: number
  delta: number
  moved: boolean
}

/** A whole-day delta clamped so the end never precedes the start. */
function clampedDelta(mode: DragMode, delta: number, s: number, e: number): number {
  if (mode === 'start') return Math.min(delta, e - s)
  if (mode === 'end') return Math.max(delta, s - e)
  return delta
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
  /** Set ⇒ draw dependency arrows from this entity's link rows (needs RelationOps.listPage). */
  dependencies?: GanttDependenciesConfig
  /** A color-tags many2many field (ViewModeDefaults.colorTagsField): bars take its colors. */
  colorTagsField?: string
}

export function GanttRenderer<T extends HasId>({
  descriptor,
  initialData,
  actions,
  startField,
  endField,
  onRecordsChange,
  serverOptions,
  dependencies,
  colorTagsField,
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
  const moveFieldsRef = useRef(moveFields)
  moveFieldsRef.current = moveFields
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

  const colorsField = colorTagsFieldOf(descriptor as ViewDescriptor, colorTagsField)
  const { colors, reload: reloadColors } = useRecordColors(descriptor.entity, colorsField, rows.map((r) => r.record.id))
  const [colorPicker, setColorPicker] = useState<{ record: T; anchor: HTMLElement } | null>(null)

  const trackRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  // Records with a write in flight: no new move until it settles, so a late
  // failure can't revert over a newer move.
  const pendingRef = useRef(new Set<string>())

  function startDrag(event: React.PointerEvent, id: string, mode: DragMode) {
    event.preventDefault()
    event.stopPropagation()
    if (pendingRef.current.has(id)) return
    const rect = trackRef.current?.getBoundingClientRect()
    const width = rect?.width ?? 0
    const { clientX: x, clientY: y } = event
    const next = { id, mode, originX: x, originY: y, x, y, pxPerDay: width / totalDays, trackLeft: rect?.left ?? 0, delta: 0, moved: false }
    dragRef.current = next
    setDrag(next)
  }

  function commit(values: Record<string, unknown>, id: string, patch: Record<string, unknown>, startWins: boolean) {
    // Day-level clamping can still invert two instants on the same day: keep end >= start.
    if (startDatetime && endDatetime) {
      const s = String(patch[startField] ?? values[startField])
      const e = String(patch[endField] ?? values[endField])
      if (Date.parse(e) < Date.parse(s)) {
        if (startWins) patch[endField] = s
        else patch[startField] = e
      }
    }
    pendingRef.current.add(id)
    void moveFields(id, patch).finally(() => pendingRef.current.delete(id))
  }

  /** Moves a bar (or one of its ends) by whole days, through the optimistic hook. */
  function shiftRow(row: { record: T; s: number; e: number }, mode: DragMode, rawDelta: number) {
    const delta = clampedDelta(mode, rawDelta, row.s, row.e)
    if (delta === 0) return
    const values = row.record as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    if (mode !== 'end') patch[startField] = shiftValue(String(values[startField]), delta, startDatetime)
    if (mode !== 'start') patch[endField] = shiftValue(String(values[endField]), delta, endDatetime)
    commit(values, row.record.id, patch, mode !== 'start')
  }

  /** Schedules an Unscheduled record from `day`: its end is kept when not
   * before that day, else the bar is one day long. */
  function placeRecord(record: T, day: Date) {
    const values = record as Record<string, unknown>
    const rawStart = values[startField]
    const oldStart = dayOf(rawStart, startDatetime)
    const start = oldStart
      ? shiftValue(String(rawStart), dayDiff(day, oldStart), startDatetime)
      : startDatetime ? day.toISOString() : isoDate(day)
    const patch: Record<string, unknown> = { [startField]: start }
    const oldEnd = dayOf(values[endField], endDatetime)
    if (!oldEnd || oldEnd < day) {
      patch[endField] = !endDatetime ? isoDate(day) : startDatetime ? start : day.toISOString()
    }
    commit(values, record.id, patch, true)
  }

  /** A bar dropped off the timeline: its start is cleared (the end, e.g. a
   * deadline, is kept), so it returns to the Unscheduled panel — undoable. */
  function unschedule(record: T) {
    const start = (record as Record<string, unknown>)[startField]
    commit(record as Record<string, unknown>, record.id, { [startField]: null }, true)
    useUndoToastStore.getState().show({
      message: `${t('Unscheduled')} "${label(record)}"`,
      // The toast outlives this render: go through the ref to the latest moveFields.
      onRecover: () => void moveFieldsRef.current(record.id, { [startField]: start }),
    })
  }

  function finishDrag() {
    const d = dragRef.current
    dragRef.current = null
    setDrag(null)
    if (!d) return
    const track = trackRef.current?.getBoundingClientRect()
    const grid = gridRef.current?.getBoundingClientRect()
    const onTimeline =
      !!track && !!grid && track.width > 0 && d.x >= track.left && d.x < track.right && d.y >= grid.top && d.y <= grid.bottom
    if (d.mode === 'place') {
      const record = unscheduled.find((r) => r.id === d.id)
      if (!record) return
      if (!d.moved) return openForm(record)
      if (!onTimeline) return
      placeRecord(record, addDays(range.start, Math.floor(((d.x - track.left) / track.width) * totalDays)))
      return
    }
    const row = rows.find((r) => r.record.id === d.id)
    if (!row) return
    if (d.mode === 'move' && !d.moved) return openForm(row.record)
    if (d.mode === 'move' && !onTimeline) return unschedule(row.record)
    shiftRow(row, d.mode, d.delta)
  }

  function onBarKey(event: React.KeyboardEvent, row: { record: T; s: number; e: number }) {
    if (event.key === 'Enter') return openForm(row.record)
    if (!canWrite || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
    if (event.ctrlKey || event.metaKey || pendingRef.current.has(row.record.id)) return
    event.preventDefault()
    shiftRow(row, event.shiftKey ? 'end' : event.altKey ? 'start' : 'move', event.key === 'ArrowRight' ? 1 : -1)
  }

  // Dependency links touching the visible rows, read in id chunks. Keyed on the
  // id set (not the date order): a move never changes the links, arrows follow `rows`.
  const [links, setLinks] = useState<Record<string, unknown>[]>([])
  const depKey = dependencies && relationOps?.listPage ? JSON.stringify(dependencies) : null
  const rowIdsKey = rows
    .map((r) => r.record.id)
    .sort()
    .join(',')
  useEffect(() => {
    const listPage = relationOps?.listPage
    if (depKey == null || !listPage || rowIdsKey === '') {
      setLinks([])
      return
    }
    const dep = JSON.parse(depKey) as GanttDependenciesConfig
    const ids = rowIdsKey.split(',')
    let cancelled = false
    const load = async () => {
      const out: Record<string, unknown>[] = []
      for (let i = 0; i < ids.length; i += GANTT_LINK_CHUNK) {
        const chunk = ids.slice(i, i + GANTT_LINK_CHUNK)
        for (let page = 1; ; page++) {
          const res = await listPage(dep.entity, {
            in: { [dep.toField]: chunk },
            order: dep.toField,
            page,
            pageSize: GANTT_PAGE_SIZE,
          })
          out.push(...(res.records as Record<string, unknown>[]))
          if (res.records.length < GANTT_PAGE_SIZE) break
        }
      }
      return out
    }
    void load()
      .then((rs) => {
        if (!cancelled) setLinks(rs)
      })
      // Arrows are decoration: a refused read (no right on the link entity) just draws none.
      .catch(() => {
        if (!cancelled) setLinks([])
      })
    return () => {
      cancelled = true
    }
  }, [depKey, rowIdsKey])
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
        x: e.clientX,
        y: e.clientY,
        delta: d.pxPerDay > 0 ? Math.round(dx / d.pxPerDay) : 0,
        moved: d.moved || Math.abs(dx) > 3 || Math.abs(e.clientY - d.originY) > 3,
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
  // An Unscheduled card being dragged: its floating preview, and the day it would land on.
  const placing = drag?.mode === 'place' && drag.moved ? (unscheduled.find((r) => r.id === drag.id) ?? null) : null
  const hoverDay = placing && drag && drag.pxPerDay > 0 ? Math.floor((drag.x - drag.trackLeft) / drag.pxPerDay) : -1
  const dropDay = hoverDay >= 0 && hoverDay < totalDays ? hoverDay : null
  const handleSx = { position: 'absolute', top: 0, bottom: 0, width: 8, cursor: 'ew-resize', touchAction: 'none' } as const

  function bar(row: { record: T; s: number; e: number }) {
    const { record, s, e } = row
    let [bs, be] = [s, e]
    if (drag?.id === record.id) {
      const delta = clampedDelta(drag.mode, drag.delta, s, e)
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
        role="button"
        tabIndex={0}
        aria-label={`${label(record)}: ${addDays(range.start, s).toLocaleDateString()} – ${addDays(range.start, e).toLocaleDateString()}`}
        onKeyDown={(ev) => onBarKey(ev, row)}
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
        style={{
          left: pct(left),
          width: pct(right - left),
          ...(colors.get(record.id) ? { background: colorStripes(colors.get(record.id)!, 'to bottom') } : {}),
        }}
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

  const now = new Date()
  const todayIdx = dayDiff(new Date(now.getFullYear(), now.getMonth(), now.getDate()), range.start)
  const markerId = useId()
  const rowY = (i: number) => HEADER_H + ROW_GAP + i * (ROW_H + ROW_GAP) + ROW_H / 2
  const rowIndex = new Map(rows.map((r, i) => [r.record.id, i]))
  const clampX = (days: number) => pct(Math.min(Math.max(days, 0), totalDays))
  const arrows: { id: string; x1: number; y1: number; x2: number; y2: number }[] = []
  if (dependencies) {
    for (const link of links) {
      const from = rowIndex.get(String(link[dependencies.fromField]))
      const to = rowIndex.get(String(link[dependencies.toField]))
      if (from == null || to == null) continue
      arrows.push({ id: String(link.id), x1: rows[from].e + 1, y1: rowY(from), x2: rows[to].s, y2: rowY(to) })
    }
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
          <Box
            ref={gridRef}
            // minHeight: the whole timeline stays a drop target for Unscheduled cards, even with few rows.
            sx={{
              display: 'grid',
              gridTemplateColumns: 'minmax(96px, 200px) minmax(0, 1fr)',
              gridAutoRows: 'min-content',
              rowGap: `${ROW_GAP}px`,
              minHeight: 240,
            }}
          >
            {/* Every cell is placed explicitly so the overlay can share the timeline column. */}
            <Box sx={{ gridColumn: 1, gridRow: 1 }} />
            <Box ref={trackRef} data-testid="gantt-track" sx={{ gridColumn: 2, gridRow: 1, position: 'relative', height: HEADER_H }}>
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
            {rows.map((row, i) => (
              <Box key={row.record.id} data-testid={`gantt-row-${row.record.id}`} sx={{ display: 'contents' }}>
                <Box sx={{ gridColumn: 1, gridRow: i + 2, display: 'flex', alignItems: 'center', minWidth: 0 }}>
                  <Button
                    size="small"
                    onClick={() => openForm(row.record)}
                    sx={{ flex: 1, height: ROW_H, justifyContent: 'flex-start', textTransform: 'none', minWidth: 0, overflow: 'hidden' }}
                  >
                    <Typography variant="body2" noWrap>
                      {label(row.record)}
                    </Typography>
                  </Button>
                  {colorsField && canWrite ? (
                    <IconButton
                      size="small"
                      aria-label={`${t('Colors of')} ${label(row.record)}`}
                      onClick={(ev) => setColorPicker({ record: row.record, anchor: ev.currentTarget })}
                    >
                      <FontAwesomeIcon icon={byPrefixAndName.fas['palette']} size="xs" />
                    </IconButton>
                  ) : null}
                </Box>
                <Box
                  sx={{ gridColumn: 2, gridRow: i + 2, position: 'relative', height: ROW_H, bgcolor: 'action.hover', borderRadius: 1 }}
                >
                  {bar(row)}
                </Box>
              </Box>
            ))}
            {rows.length === 0 && unscheduled.length > 0 && canWrite ? (
              <Typography variant="body2" color="text.secondary" sx={{ gridColumn: 2, gridRow: 2, p: 2, textAlign: 'center' }}>
                {t('Drag an unscheduled record onto the timeline to plan it.')}
              </Typography>
            ) : null}
            {dropDay != null ? (
              <Box
                data-testid="gantt-drop-day"
                sx={{ gridColumn: 2, gridRow: `1 / span ${rows.length + 1}`, position: 'relative', pointerEvents: 'none' }}
              >
                <Box
                  sx={{ position: 'absolute', top: 0, bottom: 0, bgcolor: 'primary.main', opacity: 0.12 }}
                  style={{ left: pct(dropDay), width: pct(1) }}
                />
              </Box>
            ) : null}
            <Box
              sx={{ gridColumn: 2, gridRow: `1 / span ${rows.length + 1}`, position: 'relative', pointerEvents: 'none', zIndex: 1 }}
            >
              {todayIdx >= 0 && todayIdx < totalDays ? (
                <Box
                  role="img"
                  aria-label={t('Today')}
                  sx={{ position: 'absolute', top: 0, bottom: 0, width: 2, ml: '-1px', bgcolor: 'error.main' }}
                  style={{ left: pct(todayIdx + 0.5) }}
                />
              ) : null}
              {arrows.length > 0 ? (
                <Box
                  component="svg"
                  aria-hidden
                  sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', color: 'text.secondary' }}
                >
                  <defs>
                    <marker id={markerId} viewBox="0 0 6 6" refX="6" refY="3" markerWidth="6" markerHeight="6" orient="auto">
                      <path d="M0,0 L6,3 L0,6 z" fill="currentColor" />
                    </marker>
                  </defs>
                  {arrows.map((a) => {
                    const xm = clampX((a.x1 + a.x2) / 2)
                    return (
                      <g key={a.id} data-testid={`gantt-arrow-${a.id}`} stroke="currentColor" strokeWidth={1.5}>
                        <line x1={clampX(a.x1)} y1={a.y1} x2={xm} y2={a.y1} />
                        <line x1={xm} y1={a.y1} x2={xm} y2={a.y2} />
                        <line x1={xm} y1={a.y2} x2={clampX(a.x2)} y2={a.y2} markerEnd={`url(#${markerId})`} />
                      </g>
                    )
                  })}
                </Box>
              ) : null}
            </Box>
          </Box>
        </Box>

        {colorPicker && colorsField ? (
          <Popover
            open
            anchorEl={colorPicker.anchor}
            onClose={() => setColorPicker(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
            slotProps={{
              paper: { role: 'dialog', 'aria-label': `${t('Colors of')} ${label(colorPicker.record)}`, sx: { p: 2, width: 320 } },
            }}
          >
            {/* Its own banner scope: a refused link/unlink shows here, not behind the popover. */}
            <BannerScope>
              <BannerSlot />
              <RelationColorTagsWidget
                field={colorsField}
                value={undefined}
                onChange={() => {}}
                entity={descriptor.entity}
                recordId={colorPicker.record.id}
                onLinksChange={reloadColors}
              />
            </BannerScope>
          </Popover>
        ) : null}

        {placing && drag ? (
          <Card
            data-testid="gantt-drag-preview"
            aria-hidden
            elevation={4}
            sx={{ position: 'fixed', pointerEvents: 'none', zIndex: 'tooltip', px: 1, py: 0.5, maxWidth: 220 }}
            style={{ left: drag.x + 12, top: drag.y + 12 }}
          >
            <Typography variant="caption" noWrap>
              {label(placing)}
            </Typography>
          </Card>
        ) : null}

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
                  data-testid={`gantt-unscheduled-${record.id}`}
                  className="erp-appear"
                  variant="outlined"
                  onPointerDown={canWrite ? (ev) => startDrag(ev, record.id, 'place') : undefined}
                  onClick={!canWrite && formPath ? () => openForm(record) : undefined}
                  sx={{
                    cursor: canWrite ? 'grab' : formPath ? 'pointer' : 'default',
                    touchAction: canWrite ? 'none' : undefined,
                    opacity: drag?.id === record.id ? 0.5 : 1,
                  }}
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
