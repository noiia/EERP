'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useT } from '../i18n/translate'
import type { ViewDescriptor } from './descriptor'
import { ErrorAlert } from './error-alert'
import { orderedFields } from './layout-fields'
import type { EntityActions, HasId } from './stores'
import { useOptimisticFieldMove } from './use-optimistic-field-move'

// Kanban display mode (docs/roadmaps/list-view-modes.md, Phase 2): columns from
// the configured status field's declared selection.options, cards draggable
// between them. Renders the SAME already-fetched records TreeRenderer's list
// mode does — no new fetch, no new route. Drag/PATCH/revert mechanics live in
// useOptimisticFieldMove, shared with CalendarRenderer (Phase 3).

/** Sentinel column for records whose status field is null/unset — never
 * silently dropped from the board. */
const NO_STATUS = '__no_status__'

export interface KanbanRendererProps<T extends HasId> {
  descriptor: ViewDescriptor<T>
  initialData: T[]
  actions: EntityActions<T>
  /** The entity's configured Kanban status field name (a 'selection' field). */
  statusField: string
  /**
   * Reports this renderer's working record set (initialData + any in-flight
   * optimistic edits) up to the shared TreeRenderer, so switching to another
   * mode (e.g. Graph) without a page reload sees the same data instead of a
   * stale snapshot from whenever the page last navigated.
   */
  onRecordsChange?: (records: T[]) => void
}

export function KanbanRenderer<T extends HasId>({
  descriptor,
  initialData,
  actions,
  statusField,
  onRecordsChange,
}: KanbanRendererProps<T>) {
  const t = useT()
  const router = useRouter()
  const { formPath } = descriptor
  const { records, error, moveField } = useOptimisticFieldMove(initialData, actions, statusField)
  useEffect(() => {
    onRecordsChange?.(records)
  }, [records, onRecordsChange])
  const [draggingId, setDraggingId] = useState<string | null>(null)

  const statusDescriptor = descriptor.fields.find((f) => f.name === statusField)
  const options = statusDescriptor?.selection?.options ?? []
  // Label field + up to 3 more, skipping the status field itself (redundant
  // with the column a card is already sorted into).
  const cardFields = orderedFields(descriptor, { exclude: [statusField], limit: 4 })
  const columns = [...options, NO_STATUS]

  function statusOf(record: T): string {
    const raw = (record as Record<string, unknown>)[statusField]
    return typeof raw === 'string' && raw !== '' ? raw : NO_STATUS
  }

  return (
    <Box>
      {error ? <ErrorAlert error={error} /> : null}
      <Box
        sx={{ display: 'flex', gap: 2, overflowX: 'auto', pb: 1, alignItems: 'flex-start' }}
        // `justifyContent: 'safe center'` as an sx value gets silently dropped by
        // MUI's system/emotion serialization (not a browser support gap — the
        // declaration never reaches the generated CSS rule at all), so it's set via
        // a plain inline style instead, which emotion never touches. 'safe' keeps
        // the board left-aligned instead of centered once the columns overflow, so
        // a status column can never become unreachable by scrolling left past a
        // centered start — it only centers the common case (columns narrower than
        // the board).
        style={{ justifyContent: 'safe center' }}
      >
        {columns.map((column) => {
          const label = column === NO_STATUS ? t('No status') : column
          const cards = records.filter((r) => statusOf(r) === column)
          return (
            <Box
              key={column}
              role="group"
              aria-label={label}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                if (draggingId) void moveField(draggingId, column === NO_STATUS ? null : column)
              }}
              sx={{
                minWidth: 240,
                flex: '0 0 240px',
                bgcolor: 'action.hover',
                borderRadius: 1,
                p: 1,
              }}
            >
              <Typography variant="subtitle2" sx={{ mb: 1, px: 0.5 }}>
                {label} ({cards.length})
              </Typography>
              <Stack spacing={1}>
                {cards.map((record) => (
                  <Card
                    key={record.id}
                    data-testid={`kanban-card-${record.id}`}
                    variant="outlined"
                    draggable
                    onDragStart={() => setDraggingId(record.id)}
                    onDragEnd={() => setDraggingId(null)}
                    // A real drag never fires click (the browser suppresses it once the
                    // pointer moves past the drag threshold), so a plain click here is
                    // unambiguously "clicked, didn't drag" — no separate bookkeeping needed.
                    onClick={formPath ? () => router.push(formPath.replace(':id', record.id)) : undefined}
                    sx={{ cursor: formPath ? 'pointer' : 'grab' }}
                  >
                    <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                      {cardFields.map((f, i) => (
                        <Typography
                          key={f.name}
                          variant={i === 0 ? 'body2' : 'caption'}
                          sx={{ display: 'block', fontWeight: i === 0 ? 600 : 400 }}
                        >
                          {String((record as Record<string, unknown>)[f.name] ?? '')}
                        </Typography>
                      ))}
                    </CardContent>
                  </Card>
                ))}
              </Stack>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
