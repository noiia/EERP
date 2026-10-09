'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { erpPath } from '../navigation'
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
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
import { useOptimisticFieldMove } from './use-optimistic-field-move'

// Kanban display mode (docs/roadmaps/list-view-modes.md, Phase 2): columns from
// the configured status field's declared selection.options, cards draggable
// between them. With `serverOptions` (TreeRenderer's server-paged mode), each
// column loads its own first cards and its real total over EVERY matching
// row; otherwise it renders the records it was handed. Drag/PATCH/revert
// mechanics live in useOptimisticFieldMove, shared with CalendarRenderer.

/** Sentinel column for records whose status field is null/unset — never
 * silently dropped from the board. */
const NO_STATUS = '__no_status__'

/** Cards loaded per column; the header still shows the column's full count. */
const KANBAN_COLUMN_LIMIT = 50

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
  /** Set ⇒ fetch each column from the server (RelationOps.listPage) under
   * these filters, instead of rendering `initialData`. */
  serverOptions?: EntityListOptions
}

export function KanbanRenderer<T extends HasId>({
  descriptor,
  initialData,
  actions,
  statusField,
  onRecordsChange,
  serverOptions,
}: KanbanRendererProps<T>) {
  const t = useT()
  const router = useRouter()
  const { formPath } = descriptor
  const relationOps = useRelationOps()

  const statusDescriptor = descriptor.fields.find((f) => f.name === statusField)
  const options = statusDescriptor?.selection?.options ?? []
  // Label field + up to 3 more, skipping the status field itself (redundant
  // with the column a card is already sorted into).
  const cardFields = orderedFields(descriptor, { exclude: [statusField], limit: 4 })
  const columns = [...options, NO_STATUS]

  // One request per column: its first KANBAN_COLUMN_LIMIT cards + its total.
  const [server, setServer] = useState<{ records: T[]; counts: Record<string, number> } | null>(null)
  const [loadError, setLoadError] = useState<SerializedError | null>(null)
  const serverKey = serverOptions && relationOps?.listPage ? JSON.stringify(serverOptions) : null
  const columnsKey = columns.join('\u0000')
  useEffect(() => {
    const listPage = relationOps?.listPage
    if (serverKey == null || !listPage) {
      setServer(null)
      return
    }
    const opts = JSON.parse(serverKey) as EntityListOptions
    const pinned = opts.filter?.[statusField]
    let cancelled = false
    void Promise.all(
      columns.map((column) => {
        // A search-bar filter on the status field itself empties every other column.
        if (pinned != null && column !== NO_STATUS && column !== pinned) {
          return Promise.resolve({ records: [], total: 0 })
        }
        const scope: EntityListOptions =
          column === NO_STATUS ? { empty: [statusField] } : { filter: { [statusField]: column } }
        return listPage(descriptor.entity, { ...mergeListOptions(opts, scope), pageSize: KANBAN_COLUMN_LIMIT })
      }),
    )
      .then((pages) => {
        if (cancelled) return
        setLoadError(null)
        setServer({
          records: pages.flatMap((p) => p.records) as unknown as T[],
          counts: Object.fromEntries(columns.map((c, i) => [c, pages[i].total])),
        })
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(serializeError(toApiError(e)))
      })
    return () => {
      cancelled = true
    }
  }, [serverKey, columnsKey, statusField, descriptor.entity])

  const { records, error, moveField } = useOptimisticFieldMove(server?.records ?? initialData, actions, statusField)
  useEffect(() => {
    onRecordsChange?.(records)
  }, [records, onRecordsChange])
  const [draggingId, setDraggingId] = useState<string | null>(null)

  function statusOf(record: T): string {
    const raw = (record as Record<string, unknown>)[statusField]
    return typeof raw === 'string' && raw !== '' ? raw : NO_STATUS
  }

  /** The column's full count: the server total, shifted by any cards dragged
   * in or out since it loaded. Without server data, just the cards shown. */
  function countOf(column: string, shown: number): number {
    if (!server) return shown
    const loaded = server.records.filter((r) => statusOf(r) === column).length
    return (server.counts[column] ?? 0) + shown - loaded
  }

  return (
    <Box>
      {error ? <ErrorAlert error={error} /> : null}
      {loadError ? <ErrorAlert error={loadError} /> : null}
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
          const count = countOf(column, cards.length)
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
                {label} ({count})
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
                    onClick={formPath ? () => router.push(erpPath(formPath.replace(':id', record.id))) : undefined}
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
              {count > cards.length ? (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, px: 0.5 }}>
                  +{count - cards.length} {t('more')}
                </Typography>
              ) : null}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
