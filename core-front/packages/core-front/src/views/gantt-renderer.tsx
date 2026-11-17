'use client'
import { useEffect, useId, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Collapse from '@mui/material/Collapse'
import IconButton from '@mui/material/IconButton'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Popover from '@mui/material/Popover'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import { erpPath } from '../navigation'
import { usePermission } from '../auth/Can'
import { serializeError, toApiError, type SerializedError } from '../api/errors'
import { mergeListOptions, type EntityListOptions } from '../api/list-options'
import { pinnedId, type GanttBaselineConfig, type GanttDependenciesConfig, type GanttScheduleConfig } from '../api/view-fields'
import { useT } from '../i18n/translate'
import { useUndoToastStore } from './undo-toast'
import type { ViewDescriptor } from './descriptor'
import { BannerScope, BannerSlot } from './banner'
import { colorStripes } from './color-tags'
import { ErrorAlert } from './error-alert'
import { byPrefixAndName, FontAwesomeIcon } from './icons'
import { orderedFields, orderLabel } from './layout-fields'
import { useRelationOps } from './relation-ops'
import { RelationColorTagsWidget } from './relation-widgets'
import type { EntityActions, HasId } from './stores'
import { isEmptyZoneClick, useQuickCreate } from './quick-create'
import { useOptimisticFieldMove } from './use-optimistic-field-move'
import { usePhone } from './use-phone'
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

// The zoom is kept per entity for the browser tab's session, so going to a record and
// back to the Gantt keeps the scale the user picked. Storage can throw (private mode).
const zoomKey = (entity: string) => `eerp.gantt.zoom.${entity}`
function readZoom(entity: string): Zoom {
  try {
    const v = sessionStorage.getItem(zoomKey(entity))
    if (v === 'day' || v === 'week' || v === 'month') return v
  } catch {
    // no storage: default below
  }
  return 'week'
}
function writeZoom(entity: string, zoom: Zoom) {
  try {
    sessionStorage.setItem(zoomKey(entity), zoom)
  } catch {
    // not persisted, still applied
  }
}

// The Critical-path toggle is kept per entity for the browser tab's session, the
// zoom's pattern: leaving the Gantt and coming back keeps the overlay the user asked for.
const criticalKey = (entity: string) => `eerp.gantt.critical.${entity}`
function readCritical(entity: string): boolean {
  try {
    return sessionStorage.getItem(criticalKey(entity)) === '1'
  } catch {
    // no storage: default below
  }
  return false
}
function writeCritical(entity: string, on: boolean) {
  try {
    sessionStorage.setItem(criticalKey(entity), on ? '1' : '0')
  } catch {
    // not persisted, still applied
  }
}

const DAY_MS = 86_400_000
/** Rows per request while paging the visible range. */
const GANTT_PAGE_SIZE = 200
/** Paging stops past this many records; a caption says the range holds more. */
const GANTT_RECORD_CAP = 1000
/** Unscheduled records loaded per missing date field. */
const GANTT_UNSCHEDULED_LIMIT = 50
/** Record ids per dependency-link request (`in[toField]`). */
const GANTT_LINK_CHUNK = 100
/** Task ids per baseline-task request (`in[task_id]`); baselines cap at 20 per project. */
const BASELINE_CHUNK = 100
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
function viewRange(zoom: Zoom, anchor: Date, phone = false) {
  if (zoom === 'month') {
    const n = phone ? 3 : 6
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
    const columns = Array.from({ length: n }, (_, i) => new Date(start.getFullYear(), start.getMonth() + i, 1))
    return { start, end: new Date(start.getFullYear(), start.getMonth() + n, 1), columns }
  }
  const start = monday(anchor)
  const [count, step] = zoom === 'day' ? [phone ? 7 : 14, 1] : [phone ? 6 : 12, 7]
  const columns = Array.from({ length: count }, (_, i) => addDays(start, i * step))
  return { start, end: addDays(start, count * step), columns }
}

function shiftAnchor(zoom: Zoom, anchor: Date, dir: number, phone = false): Date {
  if (zoom === 'month') return new Date(anchor.getFullYear(), anchor.getMonth() + (phone ? 3 : 6) * dir, 1)
  return addDays(anchor, (zoom === 'day' ? (phone ? 7 : 14) : phone ? 42 : 84) * dir)
}

/** Grey grid line offsets (days from the range start): every day, or 8 per month in Month zoom. */
function gridLines(zoom: Zoom, start: Date, columns: Date[], totalDays: number): number[] {
  if (zoom !== 'month') return Array.from({ length: totalDays - 1 }, (_, i) => i + 1)
  return columns.flatMap((c) => {
    const first = dayDiff(c, start)
    const len = dayDiff(new Date(c.getFullYear(), c.getMonth() + 1, 1), c)
    return Array.from({ length: 8 }, (_, k) => first + (k * len) / 8).filter((d) => d > 0)
  })
}

/** Shift + wheel: `steps` of the smallest move the Monday-aligned range shows (a month, else a week). */
function scrollAnchor(zoom: Zoom, anchor: Date, steps: number): Date {
  if (zoom === 'month') return new Date(anchor.getFullYear(), anchor.getMonth() + steps, 1)
  return addDays(anchor, 7 * steps)
}

/** Wheel distance (px) per timeline step: about one mouse notch. */
const WHEEL_STEP_PX = 100

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
  /** Set ⇒ the pinned scope's critical-path schedule (the `Critical path` toggle). */
  schedule?: GanttScheduleConfig
  /** Set ⇒ the pinned scope's baseline snapshot rows (the `Baseline` select + ghost bars). */
  baseline?: GanttBaselineConfig
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
  schedule,
  baseline,
}: GanttRendererProps<T>) {
  const t = useT()
  const theme = useTheme()
  const router = useRouter()
  const relationOps = useRelationOps()
  const canWrite = usePermission(`${descriptor.entity}:${descriptor.entity}:write`)
  const { formPath } = descriptor
  const [zoom, setZoom] = useState<Zoom>(() => readZoom(descriptor.entity))
  const [anchor, setAnchor] = useState(() => new Date())
  const phone = usePhone()
  const range = viewRange(zoom, anchor, phone)
  const totalDays = dayDiff(range.end, range.start)
  const fromIso = isoDate(range.start)
  const untilIso = isoDate(range.end)

  const isDatetime = (name: string) => descriptor.fields.find((f) => f.name === name)?.widget === 'datetime'
  const startDatetime = isDatetime(startField)
  const endDatetime = isDatetime(endField)

  const [server, setServer] = useState<{ records: T[]; capped: boolean } | null>(null)
  const [loadError, setLoadError] = useState<SerializedError | null>(null)
  const serverKey = serverOptions && relationOps?.listPage ? JSON.stringify(serverOptions) : null
  // Bumped after a quick create: the visible range is read again.
  const [reloads, setReloads] = useState(0)
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
  }, [serverKey, fromIso, untilIso, startField, endField, descriptor.entity, reloads])

  const { records, error, moveFields, addRecord } = useOptimisticFieldMove(server?.records ?? initialData, actions, startField)
  const quick = useQuickCreate(descriptor.entity, serverOptions ?? descriptor.listFilter, (created) => {
    addRecord(created as unknown as T)
    setReloads((n) => n + 1)
  })
  // A drag ending over a row fires a click there: not a quick create.
  const dragEndedAt = useRef(0)

  /** A click on a row's empty track: create a record on that day. */
  function onTrackClick(event: React.MouseEvent<HTMLElement>) {
    if (!quick.canCreate || Date.now() - dragEndedAt.current < 300 || !isEmptyZoneClick(event)) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    const idx = Math.floor(((event.clientX - rect.left) / rect.width) * totalDays)
    if (idx < 0 || idx >= totalDays) return
    const day = addDays(range.start, idx)
    quick.open({
      [startField]: startDatetime ? day.toISOString() : isoDate(day),
      [endField]: endDatetime ? day.toISOString() : isoDate(day),
    })
  }
  const moveFieldsRef = useRef(moveFields)
  moveFieldsRef.current = moveFields
  useEffect(() => {
    onRecordsChange?.(records)
  }, [records, onRecordsChange])

  // A title field ('name'/'title') beats the layout's first field, which may be an order number.
  const labelField =
    descriptor.fields.find((f) => f.name === 'name' || f.name === 'title') ??
    orderedFields(descriptor, { exclude: [startField, endField], limit: 1 })[0]
  const orderField = descriptor.viewModeDefaults?.wbsOrderField
  // With an order number: "1.2 - Design", as List, Kanban and Calendar show it.
  const label = (record: T) =>
    (orderField && orderLabel(descriptor, orderField, record as Record<string, unknown>)) ||
    (labelField ? String((record as Record<string, unknown>)[labelField.name] ?? record.id) : record.id)
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
  // The phone toolbar's More menu: the pinned-scope controls (Critical path, Baseline)
  // don't fit the 390px row, so they sit in it (the diagram canvas' pattern).
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null)

  const trackRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  // Shift + wheel over the timeline moves it back and forth. Native listener:
  // React's onWheel is passive, so it couldn't stop the page scrolling sideways.
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    let pending = 0
    const onWheel = (e: WheelEvent) => {
      if (!e.shiftKey) return
      // Browsers turn a shifted wheel into deltaX; some keep deltaY. Lines (Firefox) → px.
      const delta = (e.deltaX || e.deltaY) * (e.deltaMode === 1 ? 16 : 1)
      if (!delta) return
      e.preventDefault()
      pending += delta
      const steps = Math.trunc(pending / WHEEL_STEP_PX)
      if (steps === 0) return
      pending -= steps * WHEEL_STEP_PX
      setAnchor((a) => scrollAnchor(zoom, a, steps))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoom])
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
    dragEndedAt.current = Date.now()
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

  // The pinned scope, or null when the list is not pinned: the schedule and the
  // baselines exist for a pinned project only (the search bar's single-value pin).
  const schedulePin = schedule && relationOps?.get ? pinnedId(serverOptions, schedule.scopeField) : null
  const baselinePin = baseline && relationOps?.listPage ? pinnedId(serverOptions, baseline.scopeField) : null

  // The Critical-path toggle, kept per entity for the tab session (the zoom's pattern).
  const [criticalOn, setCriticalOn] = useState(() => readCritical(descriptor.entity))
  const onCriticalToggle = () => {
    const next = !criticalOn
    setCriticalOn(next)
    writeCritical(descriptor.entity, next)
  }

  // The pinned project's schedule (WP3), read once per pinned id and toggle state,
  // so a bar move never refetches it.
  const [scheduleData, setScheduleData] = useState<{ cycle: boolean; tasks: Map<string, { slack: number; critical: boolean }> } | null>(null)
  const scheduleKey = schedulePin && schedule ? JSON.stringify(schedule) : null
  useEffect(() => {
    if (scheduleKey == null || !schedulePin || !criticalOn || !relationOps?.get) {
      setScheduleData(null)
      return
    }
    const cfg = JSON.parse(scheduleKey) as GanttScheduleConfig
    let cancelled = false
    relationOps
      .get(cfg.scopeEntity, `${schedulePin}/${cfg.path}`)
      .then((res) => {
        if (cancelled) return
        // The relation op returns a record; a host (or a test double) may hand the payload back bare.
        const body = (res as { body?: unknown }).body ?? res
        const payload = body as { cycle?: boolean; tasks?: { id: string | number; slack: number; critical: boolean }[] } | null
        const tasks = new Map<string, { slack: number; critical: boolean }>()
        for (const task of payload?.tasks ?? []) tasks.set(String(task.id), { slack: Number(task.slack), critical: Boolean(task.critical) })
        setScheduleData({ cycle: Boolean(payload?.cycle), tasks })
      })
      .catch(() => {
        if (!cancelled) setScheduleData(null)
      })
    return () => {
      cancelled = true
    }
  }, [scheduleKey, schedulePin, criticalOn])

  // The pinned project's baselines, newest first (the server caps them: one page).
  const [baselines, setBaselines] = useState<{ id: string; name: string }[]>([])
  const baselineKey = baselinePin && baseline ? JSON.stringify(baseline) : null
  const [pickedBaseline, setPickedBaseline] = useState('')
  useEffect(() => {
    if (baselineKey == null || !baselinePin || !relationOps?.listPage) {
      setBaselines([])
      return
    }
    const cfg = JSON.parse(baselineKey) as GanttBaselineConfig
    let cancelled = false
    relationOps
      .listPage(cfg.entity, { filter: { [cfg.scopeField]: baselinePin }, order: '-created_at', pageSize: 100 })
      .then((page) => {
        if (cancelled) return
        setBaselines(page.records.map((r) => ({ id: r.id, name: String(r.name ?? '') })))
      })
      .catch(() => {
        if (!cancelled) setBaselines([])
      })
    return () => {
      cancelled = true
    }
  }, [baselineKey, baselinePin])
  // A different pinned project starts with no baseline picked.
  useEffect(() => {
    setPickedBaseline('')
  }, [baselinePin])

  // The picked baseline's task rows for the visible rows, read in id chunks (the
  // dependency-links pattern): a ghost bar under every task the snapshot holds.
  const [baselineBars, setBaselineBars] = useState<Map<string, { start: Date; end: Date }>>(new Map())
  useEffect(() => {
    if (baselineKey == null || !baselinePin || !pickedBaseline || !relationOps?.listPage || rowIdsKey === '') {
      setBaselineBars(new Map())
      return
    }
    const cfg = JSON.parse(baselineKey) as GanttBaselineConfig
    const ids = rowIdsKey.split(',')
    const listPage = relationOps.listPage
    let cancelled = false
    const load = async () => {
      const out: Record<string, unknown>[] = []
      for (let i = 0; i < ids.length; i += BASELINE_CHUNK) {
        const chunk = ids.slice(i, i + BASELINE_CHUNK)
        for (let page = 1; ; page++) {
          const res = await listPage(cfg.taskEntity, {
            // `baseline_id` is the task entity's FK to its baseline (the WP3 baseline schema).
            filter: { [cfg.scopeField]: baselinePin, baseline_id: pickedBaseline },
            in: { [cfg.linkField]: chunk },
            page,
            pageSize: BASELINE_CHUNK,
          })
          out.push(...(res.records as Record<string, unknown>[]))
          if (res.records.length < BASELINE_CHUNK) break
        }
      }
      return out
    }
    void load()
      .then((rs) => {
        if (cancelled) return
        const m = new Map<string, { start: Date; end: Date }>()
        for (const r of rs) {
          const start = dayOf(r[cfg.startField], isDatetime(cfg.startField))
          const end = dayOf(r[cfg.endField], isDatetime(cfg.endField))
          if (!start || !end) continue
          m.set(String(r[cfg.linkField]), { start, end })
        }
        setBaselineBars(m)
      })
      .catch(() => {
        if (!cancelled) setBaselineBars(new Map())
      })
    return () => {
      cancelled = true
    }
  }, [baselineKey, baselinePin, pickedBaseline, rowIdsKey])
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
  const handleSx = { position: 'absolute', top: 0, bottom: 0, width: phone ? 16 : 8, cursor: 'ew-resize', touchAction: 'none' } as const

  /** The picked baseline's snapshot of this row: a 6px ghost bar under the live one,
   * clipped to the visible range like the bar itself. Rows the snapshot lacks get none. */
  function ghostBar(row: { record: T; s: number; e: number }) {
    if (!pickedBaseline) return null
    const g = baselineBars.get(row.record.id)
    if (!g) return null
    const si = dayDiff(g.start, range.start)
    const ei = Math.max(si, dayDiff(g.end, range.start))
    if (si >= totalDays || ei < 0) return null
    const left = Math.max(si, 0)
    const right = Math.min(ei + 1, totalDays)
    if (right <= left) return null
    return (
      <Box
        data-testid={`gantt-baseline-${row.record.id}`}
        aria-hidden
        sx={{ position: 'absolute', bottom: 0, height: 6, bgcolor: 'action.disabled', borderRadius: 0.5, pointerEvents: 'none' }}
        style={{ left: pct(left), width: pct(right - left) }}
      />
    )
  }

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
    // The schedule overlay (toggle on): critical bars get the error outline, and every
    // scheduled bar its slack in the label — a non-color cue as well as the color one.
    const sched = criticalOn ? scheduleData?.tasks.get(record.id) : undefined
    return (
      <Box
        data-testid={`gantt-bar-${record.id}`}
        title={label(record)}
        role="button"
        tabIndex={0}
        aria-label={`${label(record)}: ${addDays(range.start, s).toLocaleDateString()} – ${addDays(range.start, e).toLocaleDateString()}${sched ? `, slack ${sched.slack} d` : ''}`}
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
          ...(sched?.critical ? { outlineWidth: '2px', outlineStyle: 'solid', outlineColor: theme.palette.error.main } : {}),
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
      {quick.dialog}
      <Stack direction={phone ? 'column' : 'row'} spacing={2} sx={{ alignItems: phone ? 'stretch' : 'flex-start' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mb: 1 }}>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={zoom}
              onChange={(_e, next: Zoom | null) => {
                if (!next) return
                setZoom(next)
                writeZoom(descriptor.entity, next)
              }}
              aria-label={t('Zoom')}
            >
              <ToggleButton value="day">{t('Day')}</ToggleButton>
              <ToggleButton value="week">{t('Week')}</ToggleButton>
              <ToggleButton value="month">{t('Month')}</ToggleButton>
            </ToggleButtonGroup>
            {phone ? (
              <IconButton aria-label={t('Previous period')} sx={{ minWidth: 40, minHeight: 40 }} onClick={() => setAnchor((a) => shiftAnchor(zoom, a, -1, phone))}>
                <FontAwesomeIcon icon={byPrefixAndName.fas['chevron-left']} />
              </IconButton>
            ) : (
              <Button size="small" aria-label={t('Previous period')} onClick={() => setAnchor((a) => shiftAnchor(zoom, a, -1))}>
                {t('Previous')}
              </Button>
            )}
            <Button size="small" sx={{ minHeight: phone ? 40 : undefined }} onClick={() => setAnchor(new Date())}>
              {t('Today')}
            </Button>
            {phone ? (
              <IconButton aria-label={t('Next period')} sx={{ minWidth: 40, minHeight: 40 }} onClick={() => setAnchor((a) => shiftAnchor(zoom, a, 1, phone))}>
                <FontAwesomeIcon icon={byPrefixAndName.fas['chevron-right']} />
              </IconButton>
            ) : (
              <Button size="small" aria-label={t('Next period')} onClick={() => setAnchor((a) => shiftAnchor(zoom, a, 1))}>
                {t('Next')}
              </Button>
            )}
            {!phone && schedulePin ? (
              <Button size="small" aria-pressed={criticalOn} onClick={onCriticalToggle}>
                {t('Critical path')}
              </Button>
            ) : null}
            {!phone && baselinePin ? (
              <Select size="small" aria-label={t('Baseline')} value={pickedBaseline} displayEmpty onChange={(e) => setPickedBaseline(e.target.value)}>
                <MenuItem value="">{t('No baseline')}</MenuItem>
                {baselines.map((b) => (
                  <MenuItem key={b.id} value={b.id}>
                    {b.name}
                  </MenuItem>
                ))}
              </Select>
            ) : null}
            {phone && (schedulePin || baselinePin) ? (
              <IconButton aria-label={t('More')} sx={{ minWidth: 40, minHeight: 40 }} onClick={(e) => setMoreAnchor(e.currentTarget)}>
                <FontAwesomeIcon icon={byPrefixAndName.fas['ellipsis-vertical']} />
              </IconButton>
            ) : null}
            <Typography variant="subtitle2" sx={{ flexBasis: phone ? '100%' : 'auto' }}>
              {range.start.toLocaleDateString()} – {addDays(range.end, -1).toLocaleDateString()}
            </Typography>
            {server?.capped ? (
              <Typography variant="caption" color="text.secondary">
                {GANTT_RECORD_CAP} {t('records shown — narrow the range or the filters to see the rest')}
              </Typography>
            ) : null}
            {criticalOn && scheduleData?.cycle ? (
              <Typography variant="caption" color="text.secondary">
                {t('Dependency cycle: no critical path')}
              </Typography>
            ) : null}
          </Box>
          <Box
            ref={gridRef}
            // minHeight: the whole timeline stays a drop target for Unscheduled cards, even with few rows.
            sx={{
              display: 'grid',
              gridTemplateColumns: phone ? '88px minmax(0, 1fr)' : 'minmax(96px, 200px) minmax(0, 1fr)',
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
            {rows.length > 0 ? (
              <Box
                data-testid="gantt-grid-lines"
                aria-hidden
                sx={{ gridColumn: 2, gridRow: `2 / span ${rows.length}`, position: 'relative', pointerEvents: 'none' }}
              >
                {gridLines(zoom, range.start, range.columns, totalDays).map((d) => (
                  <Box key={d} sx={{ position: 'absolute', top: 0, bottom: 0, width: '1px', bgcolor: 'divider' }} style={{ left: pct(d) }} />
                ))}
              </Box>
            ) : null}
            {rows.map((row, i) => (
              <Box key={row.record.id} data-testid={`gantt-row-${row.record.id}`} sx={{ display: 'contents' }}>
                <Box sx={{ gridColumn: 1, gridRow: i + 2, display: 'flex', alignItems: 'center', minWidth: 0 }}>
                  <Button
                    size="small"
                    onClick={() => openForm(row.record)}
                    sx={{ flex: 1, height: ROW_H, justifyContent: 'flex-start', textTransform: 'none', minWidth: 0, overflow: 'hidden' }}
                  >
                    <Typography
                      variant={phone ? 'caption' : 'body2'}
                      noWrap={!phone}
                      sx={phone ? { lineHeight: '14px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', textAlign: 'left', whiteSpace: 'normal' } : undefined}
                    >
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
                  data-testid={`gantt-row-track-${row.record.id}`}
                  onClick={onTrackClick}
                  sx={{
                    gridColumn: 2,
                    gridRow: i + 2,
                    position: 'relative',
                    height: ROW_H,
                    bgcolor: 'action.hover',
                    borderRadius: 1,
                    cursor: quick.canCreate ? 'cell' : undefined,
                  }}
                >
                  {/* The baseline snapshot under the live bar, so the bar stacks on top. */}
                  {ghostBar(row)}
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
            sx={{ width: phone ? '100%' : 220, flexShrink: 0, bgcolor: 'action.hover', borderRadius: 1, p: 1 }}
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

      {phone && (schedulePin || baselinePin) ? (
        <Menu open={!!moreAnchor} anchorEl={moreAnchor} onClose={() => setMoreAnchor(null)}>
          {schedulePin ? (
            <MenuItem selected={criticalOn} onClick={() => { setMoreAnchor(null); onCriticalToggle() }}>
              {t('Critical path')}
            </MenuItem>
          ) : null}
          {baselinePin ? (
            <>
              <MenuItem selected={pickedBaseline === ''} onClick={() => { setMoreAnchor(null); setPickedBaseline('') }}>
                {t('No baseline')}
              </MenuItem>
              {baselines.map((b) => (
                <MenuItem key={b.id} selected={pickedBaseline === b.id} onClick={() => { setMoreAnchor(null); setPickedBaseline(b.id) }}>
                  {b.name}
                </MenuItem>
              ))}
            </>
          ) : null}
        </Menu>
      ) : null}
    </Box>
  )
}
