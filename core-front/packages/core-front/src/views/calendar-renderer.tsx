'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { erpPath } from '../navigation'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Collapse from '@mui/material/Collapse'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { serializeError, toApiError, type SerializedError } from '../api/errors'
import { mergeListOptions, type EntityListOptions } from '../api/list-options'
import { useT } from '../i18n/translate'
import type { ViewDescriptor } from './descriptor'
import { ErrorAlert } from './error-alert'
import { orderedFields } from './layout-fields'
import { useRelationOps } from './relation-ops'
import type { EntityActions, HasId } from './stores'
import { useUndoToastStore } from './undo-toast'
import { useOptimisticFieldMove } from './use-optimistic-field-move'

// Calendar display mode (docs/roadmaps/list-view-modes.md, Phase 3): a month
// grid positioning records by their configured date field; records with no
// value in that field list in an "Unscheduled" panel instead of being
// dropped. With `serverOptions` (TreeRenderer's server-paged mode) it loads
// the visible month (a gte/lt range on the date field) and the unscheduled
// records (`empty[]`) from the server, refetching on every month change;
// otherwise it re-filters the records it was handed. Drag/PATCH/revert mechanics are the SAME
// useOptimisticFieldMove hook KanbanRenderer uses (Phase 2) — reused, not
// duplicated.

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Records loaded for one month; past it, a caption says how many aren't shown. */
const CALENDAR_MONTH_LIMIT = 1000
/** Unscheduled records loaded; the panel header still shows the full count. */
const CALENDAR_UNSCHEDULED_LIMIT = 50

/** Local-time grid math throughout — never `new Date('YYYY-MM-DD')`, which
 * jsdom/browsers parse as UTC midnight and can land on the wrong local day. */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

function firstWeekday(year: number, month: number): number {
  return new Date(year, month, 1).getDay()
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function monthLabel(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

export interface CalendarRendererProps<T extends HasId> {
  descriptor: ViewDescriptor<T>
  initialData: T[]
  actions: EntityActions<T>
  /** The entity's configured Calendar date field name (a 'date' field). */
  dateField: string
  /**
   * Names a `type: 'boolean'` field: a record whose value is true renders
   * its card with a red accent — e.g. cron_history's `failed`
   * (ViewModeDefaults.calendarColorField, api/view-fields.ts). Omitted ⇒
   * no coloring, every card renders the same as before this existed.
   */
  colorField?: string
  /**
   * Reports this renderer's working record set (initialData + any in-flight
   * optimistic edits) up to the shared TreeRenderer, so switching to another
   * mode (e.g. Graph) without a page reload sees the same data instead of a
   * stale snapshot from whenever the page last navigated.
   */
  onRecordsChange?: (records: T[]) => void
  /** Set ⇒ fetch the visible month + unscheduled records from the server
   * (RelationOps.listPage) under these filters, instead of `initialData`. */
  serverOptions?: EntityListOptions
}

export function CalendarRenderer<T extends HasId>({
  descriptor,
  initialData,
  actions,
  dateField,
  colorField,
  onRecordsChange,
  serverOptions,
}: CalendarRendererProps<T>) {
  const t = useT()
  const router = useRouter()
  const { formPath } = descriptor
  const relationOps = useRelationOps()
  const now = new Date()
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() })

  const [server, setServer] = useState<{
    records: T[]
    monthTotal: number
    monthLoaded: number
    unscheduledTotal: number
    unscheduledLoaded: number
  } | null>(null)
  const [loadError, setLoadError] = useState<SerializedError | null>(null)
  const serverKey = serverOptions && relationOps?.listPage ? JSON.stringify(serverOptions) : null
  useEffect(() => {
    const listPage = relationOps?.listPage
    if (serverKey == null || !listPage) {
      setServer(null)
      return
    }
    const opts = JSON.parse(serverKey) as EntityListOptions
    const from = isoDate(cursor.year, cursor.month, 1)
    const next = new Date(cursor.year, cursor.month + 1, 1)
    const until = isoDate(next.getFullYear(), next.getMonth(), 1)
    // Keep a search-bar lower bound on this same field when it's the tighter one.
    const userFrom = opts.gte?.[dateField]
    const monthScope: EntityListOptions = {
      gte: { [dateField]: userFrom && userFrom > from ? userFrom : from },
      lt: { [dateField]: until },
    }
    let cancelled = false
    void Promise.all([
      listPage(descriptor.entity, { ...mergeListOptions(opts, monthScope), pageSize: CALENDAR_MONTH_LIMIT }),
      listPage(descriptor.entity, {
        ...mergeListOptions(opts, { empty: [dateField] }),
        pageSize: CALENDAR_UNSCHEDULED_LIMIT,
      }),
    ])
      .then(([month, unscheduled]) => {
        if (cancelled) return
        setLoadError(null)
        setServer({
          records: [...month.records, ...unscheduled.records] as unknown as T[],
          monthTotal: month.total,
          monthLoaded: month.records.length,
          unscheduledTotal: unscheduled.total,
          unscheduledLoaded: unscheduled.records.length,
        })
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(serializeError(toApiError(e)))
      })
    return () => {
      cancelled = true
    }
  }, [serverKey, cursor.year, cursor.month, dateField, descriptor.entity])

  const { records, error, moveField } = useOptimisticFieldMove(server?.records ?? initialData, actions, dateField)
  useEffect(() => {
    onRecordsChange?.(records)
  }, [records, onRecordsChange])
  // The undo toast's onRecover fires long after this render is gone — closing over
  // `moveField` directly would call back into that stale render's `records`, whose
  // no-op-if-unchanged guard would then see the ALREADY-cleared value and do
  // nothing. A ref always dereferences the latest moveField/records pair.
  const moveFieldRef = useRef(moveField)
  moveFieldRef.current = moveField
  const [dragging, setDragging] = useState<T | null>(null)
  // Set by a valid onDrop (day cell / Unscheduled) before onDragEnd fires; tells
  // onDragEnd whether the drag landed on one of THIS component's own drop targets
  // or was released somewhere outside it entirely (desktop, another panel, ...).
  const droppedRef = useRef(false)

  // Label field only — day cells are compact, unlike a Kanban card.
  const [labelField] = orderedFields(descriptor, { exclude: [dateField], limit: 1 })

  // A 'date' field's stored value isn't always a bare 'YYYY-MM-DD' string — a
  // real Go `time.Time` column round-trips as a full RFC3339 timestamp (e.g.
  // "2026-07-10T00:00:00Z"). Bucketing by the raw value would never match an
  // `isoDate()` day key, silently dropping every such record from BOTH the
  // grid and the Unscheduled panel. Extract just the date prefix — never
  // `new Date(...)` (local-timezone-shift pitfall, same discipline as
  // graph-aggregate.ts's `bucketKey`).
  function dateOf(record: T): string | null {
    const raw = (record as Record<string, unknown>)[dateField]
    if (typeof raw !== 'string' || raw === '') return null
    return /^\d{4}-\d{2}-\d{2}/.exec(raw)?.[0] ?? null
  }

  const byDay = new Map<string, T[]>()
  const unscheduled: T[] = []
  for (const record of records) {
    const value = dateOf(record)
    if (value == null) {
      unscheduled.push(record)
      continue
    }
    const bucket = byDay.get(value) ?? []
    bucket.push(record)
    byDay.set(value, bucket)
  }

  // Server totals, shifted by any cards dragged in/out of Unscheduled since.
  const unscheduledCount = server
    ? server.unscheduledTotal + unscheduled.length - server.unscheduledLoaded
    : unscheduled.length
  const monthHidden = server ? server.monthTotal - server.monthLoaded : 0

  function changeMonth(delta: number) {
    setCursor(({ year, month }) => {
      const next = new Date(year, month + delta, 1)
      return { year: next.getFullYear(), month: next.getMonth() }
    })
  }

  function label(record: T): string {
    if (!labelField) return record.id
    return String((record as Record<string, unknown>)[labelField.name] ?? record.id)
  }

  function isFlagged(record: T): boolean {
    if (!colorField) return false
    return (record as Record<string, unknown>)[colorField] === true
  }

  function dayCard(record: T) {
    const flagged = isFlagged(record)
    return (
      <Card
        key={record.id}
        data-testid={`calendar-card-${record.id}`}
        variant="outlined"
        draggable
        onDragStart={() => {
          droppedRef.current = false
          setDragging(record)
        }}
        onDragEnd={() => {
          const dropped = droppedRef.current
          setDragging(null)
          if (!dropped) {
            const date = dateOf(record)
            if (date) {
              void moveField(record.id, null)
              useUndoToastStore.getState().show({
                message: `${t('Removed')} ${date} ${t('from')} "${label(record)}"`,
                onRecover: () => void moveFieldRef.current(record.id, date),
              })
            }
          }
        }}
        // A real drag never fires click (the browser suppresses it once the pointer
        // moves past the drag threshold), so a plain click here is unambiguously
        // "clicked, didn't drag" — no separate bookkeeping needed.
        onClick={formPath ? () => router.push(erpPath(formPath.replace(':id', record.id))) : undefined}
        sx={{
          cursor: formPath ? 'pointer' : 'grab',
          ...(flagged && {
            borderColor: 'error.main',
            borderLeftWidth: 3,
            bgcolor: 'error.main',
            '& .MuiTypography-root': { color: 'error.contrastText' },
          }),
        }}
      >
        <CardContent sx={{ p: 1, '&:last-child': { pb: 1 } }}>
          <Typography variant="caption" sx={{ display: 'block' }}>
            {label(record)}
          </Typography>
        </CardContent>
      </Card>
    )
  }

  const totalDays = daysInMonth(cursor.year, cursor.month)
  const leadingBlanks = firstWeekday(cursor.year, cursor.month)
  const days = Array.from({ length: totalDays }, (_, i) => i + 1)

  return (
    <Box>
      {error ? <ErrorAlert error={error} /> : null}
      {loadError ? <ErrorAlert error={loadError} /> : null}
      <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Button size="small" aria-label={t('Previous month')} onClick={() => changeMonth(-1)}>
              {t('Previous')}
            </Button>
            <Box sx={{ textAlign: 'center' }}>
              <Typography variant="subtitle1">{monthLabel(cursor.year, cursor.month)}</Typography>
              {monthHidden > 0 ? (
                <Typography variant="caption" color="text.secondary">
                  {server!.monthLoaded} / {server!.monthTotal} {t('shown this month')}
                </Typography>
              ) : null}
            </Box>
            <Button size="small" aria-label={t('Next month')} onClick={() => changeMonth(1)}>
              {t('Next')}
            </Button>
          </Box>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 0.5 }}>
            {WEEKDAY_LABELS.map((weekday) => (
              <Typography key={weekday} variant="caption" align="center" color="text.secondary">
                {t(weekday)}
              </Typography>
            ))}
            {Array.from({ length: leadingBlanks }, (_, i) => (
              <Box key={`blank-${i}`} />
            ))}
            {days.map((day) => {
              const iso = isoDate(cursor.year, cursor.month, day)
              const cards = byDay.get(iso) ?? []
              return (
                <Box
                  key={iso}
                  role="group"
                  aria-label={iso}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    droppedRef.current = true
                    if (dragging) void moveField(dragging.id, iso)
                  }}
                  sx={{
                    minHeight: 72,
                    bgcolor: 'action.hover',
                    borderRadius: 1,
                    p: 0.5,
                  }}
                >
                  <Typography variant="caption" color="text.secondary">
                    {day}
                  </Typography>
                  <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                    {cards.map(dayCard)}
                  </Stack>
                </Box>
              )
            })}
          </Box>
        </Box>

        <Collapse in={unscheduledCount > 0} orientation="horizontal" unmountOnExit>
          <Box
            role="group"
            aria-label={t('Unscheduled')}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              droppedRef.current = true
              if (dragging) void moveField(dragging.id, null)
            }}
            sx={{ width: 220, flexShrink: 0, bgcolor: 'action.hover', borderRadius: 1, p: 1 }}
          >
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              {t('Unscheduled')} ({unscheduledCount})
            </Typography>
            <Stack spacing={0.5}>{unscheduled.map(dayCard)}</Stack>
          </Box>
        </Collapse>
      </Stack>
    </Box>
  )
}
