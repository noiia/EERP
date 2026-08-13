'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Collapse from '@mui/material/Collapse'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useT } from '../i18n/translate'
import type { ViewDescriptor } from './descriptor'
import { ErrorAlert } from './error-alert'
import { orderedFields } from './layout-fields'
import type { EntityActions, HasId } from './stores'
import { useUndoToastStore } from './undo-toast'
import { useOptimisticFieldMove } from './use-optimistic-field-move'

// Calendar display mode (docs/roadmaps/list-view-modes.md, Phase 3): a month
// grid positioning records by their configured date field; records with no
// value in that field list in an "Unscheduled" panel instead of being
// dropped. Renders the SAME already-fetched records TreeRenderer's list mode
// does — no new fetch, no new route; browsing months re-filters that same
// set, it never refetches. Drag/PATCH/revert mechanics are the SAME
// useOptimisticFieldMove hook KanbanRenderer uses (Phase 2) — reused, not
// duplicated.

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

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
   * Reports this renderer's working record set (initialData + any in-flight
   * optimistic edits) up to the shared TreeRenderer, so switching to another
   * mode (e.g. Graph) without a page reload sees the same data instead of a
   * stale snapshot from whenever the page last navigated.
   */
  onRecordsChange?: (records: T[]) => void
}

export function CalendarRenderer<T extends HasId>({
  descriptor,
  initialData,
  actions,
  dateField,
  onRecordsChange,
}: CalendarRendererProps<T>) {
  const t = useT()
  const router = useRouter()
  const { formPath } = descriptor
  const { records, error, moveField } = useOptimisticFieldMove(initialData, actions, dateField)
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
  const now = new Date()
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() })

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

  function dayCard(record: T) {
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
        onClick={formPath ? () => router.push(formPath.replace(':id', record.id)) : undefined}
        sx={{ cursor: formPath ? 'pointer' : 'grab' }}
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
      <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Button size="small" aria-label={t('Previous month')} onClick={() => changeMonth(-1)}>
              {t('Previous')}
            </Button>
            <Typography variant="subtitle1">{monthLabel(cursor.year, cursor.month)}</Typography>
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

        <Collapse in={unscheduled.length > 0} orientation="horizontal" unmountOnExit>
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
              {t('Unscheduled')} ({unscheduled.length})
            </Typography>
            <Stack spacing={0.5}>{unscheduled.map(dayCard)}</Stack>
          </Box>
        </Collapse>
      </Stack>
    </Box>
  )
}
