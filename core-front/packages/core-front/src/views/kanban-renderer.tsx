'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { erpPath } from '../navigation'
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import ButtonBase from '@mui/material/ButtonBase'
import TextField from '@mui/material/TextField'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { serializeError, toApiError, type SerializedError } from '../api/errors'
import { mergeListOptions, type EntityListOptions } from '../api/list-options'
import type { KanbanColumnsConfig } from '../api/view-fields'
import { useT } from '../i18n/translate'
import { fieldLabel, type ViewDescriptor } from './descriptor'
import { byPrefixAndName, FontAwesomeIcon } from './icons'
import {
  kanbanColumnsGuard,
  mergeColumnsByLabel,
  resolveDropTarget,
  splitColumns,
  type KanbanColumn,
} from './kanban-columns'
import { ErrorAlert } from './error-alert'
import { orderedFields } from './layout-fields'
import { formatTotal } from './total-format'
import { useRelationOps, type RelationRecord } from './relation-ops'
import type { EntityActions, HasId } from './stores'
import { useOptimisticFieldMove } from './use-optimistic-field-move'

// Kanban display mode (docs/roadmaps/list-view-modes.md, Phase 2): columns from
// the configured status field's declared selection.options, cards draggable
// between them. With `serverOptions` (TreeRenderer's server-paged mode), each
// column loads its own first cards and its real total over EVERY matching
// row; otherwise it renders the records it was handed. Drag/PATCH/revert
// mechanics live in useOptimisticFieldMove, shared with CalendarRenderer.
// A many2one status field with `columnsConfig` instead takes its columns from
// the related entity's records (Odoo-style stages, kanban-columns.ts): one per
// record when the list pins `scopeField` to one id (editable there when the
// named guard allows), else merged by label across scopes.

/** Sentinel column for records whose status field is null/unset — never
 * silently dropped from the board. */
const NO_STATUS = '__no_status__'

/** Cards loaded per column; the header still shows the column's full count. */
const KANBAN_COLUMN_LIMIT = 50

// shortcut: column records past this many are not shown; page them if a board ever needs more.
const KANBAN_STAGE_LIMIT = 200

/** Orders are rewritten 10, 20, … so a later insert fits between two columns. */
const ORDER_STEP = 10

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
  /** Set + a many2one statusField ⇒ columns are the related entity's records. */
  columnsConfig?: KanbanColumnsConfig
  /** A boolean field: true ⇒ the card shows an error chip labeled with the field's label. */
  badgeField?: string
}

export function KanbanRenderer<T extends HasId>({
  descriptor,
  initialData,
  actions,
  statusField,
  onRecordsChange,
  serverOptions,
  columnsConfig,
  badgeField,
}: KanbanRendererProps<T>) {
  const t = useT()
  const router = useRouter()
  const { formPath } = descriptor
  const relationOps = useRelationOps()

  const statusDescriptor = descriptor.fields.find((f) => f.name === statusField)
  const relation = statusDescriptor?.type === 'relation' && statusDescriptor.relation?.kind === 'many2one'
    ? statusDescriptor.relation
    : undefined
  const config = relation ? columnsConfig : undefined
  const options = statusDescriptor?.selection?.options ?? []
  const badgeDescriptor = badgeField ? descriptor.fields.find((f) => f.name === badgeField) : undefined
  // Label field + up to 3 more, skipping the status field itself (redundant
  // with the column a card is already sorted into) and the badge field (a chip).
  const cardFields = orderedFields(descriptor, { exclude: badgeField ? [statusField, badgeField] : [statusField], limit: 4 })

  // many2one columns: the related records, scoped when the list pins scopeField to one id.
  const scopeId = config?.scopeField ? (serverOptions ?? descriptor.listFilter)?.filter?.[config.scopeField] : undefined
  const [stages, setStages] = useState<RelationRecord[] | null>(null)
  const [stagesVersion, setStagesVersion] = useState(0)
  const [columnError, setColumnError] = useState<SerializedError | null>(null)
  const [mayEdit, setMayEdit] = useState(false)
  // Another scope (or entity): drop the previous one's columns and edit right during
  // this very render, so nothing reads them under the new filter while it loads.
  const scopeKey = `${relation?.entity ?? ''}\u0000${scopeId ?? ''}`
  const [loadedScope, setLoadedScope] = useState(scopeKey)
  if (loadedScope !== scopeKey) {
    setLoadedScope(scopeKey)
    setStages(null)
    setMayEdit(false)
  }
  useEffect(() => {
    const listPage = relationOps?.listPage
    if (!config || !relation || !listPage) {
      setStages(null)
      return
    }
    let cancelled = false
    const scope = scopeId && config.scopeField ? { filter: { [config.scopeField]: scopeId } } : {}
    listPage(relation.entity, { ...scope, order: config.orderField, pageSize: KANBAN_STAGE_LIMIT })
      .then((page) => {
        if (!cancelled) setStages(page.records)
      })
      .catch((e: unknown) => {
        if (!cancelled) setColumnError(serializeError(toApiError(e)))
      })
    return () => {
      cancelled = true
    }
  }, [relation?.entity, config?.orderField, config?.scopeField, scopeId, stagesVersion, Boolean(config)])

  // Column editing: scoped boards only, when the module's named guard says so.
  useEffect(() => {
    const guard = config?.canEdit ? kanbanColumnsGuard(config.canEdit) : undefined
    if (!guard || !scopeId) {
      setMayEdit(false)
      return
    }
    let cancelled = false
    guard(scopeId, relationOps)
      .then((ok) => !cancelled && setMayEdit(ok))
      .catch(() => !cancelled && setMayEdit(false))
    return () => {
      cancelled = true
    }
  }, [config?.canEdit, scopeId, relationOps])
  const canEditColumns = mayEdit && Boolean(relationOps?.update)

  const columns: KanbanColumn[] = useMemo(() => {
    if (!config) {
      return options.map((o) => ({ key: o, label: o, order: 0, fold: false, stages: [{ id: o }] }))
    }
    if (!stages) return []
    return scopeId ? splitColumns(stages, config) : mergeColumnsByLabel(stages, config)
  }, [config, options, stages, scopeId])
  const columnKeys = [...columns.map((c) => c.key), NO_STATUS]
  const keyOfId = useMemo(() => new Map(columns.flatMap((c) => c.stages.map((st) => [st.id, c.key] as const))), [columns])

  // One request per column: its first KANBAN_COLUMN_LIMIT cards + its total.
  const [server, setServer] = useState<{ records: T[]; counts: Record<string, number>; estimated: Record<string, boolean> } | null>(null)
  const [loadError, setLoadError] = useState<SerializedError | null>(null)
  const serverKey = serverOptions && relationOps?.listPage ? JSON.stringify(serverOptions) : null
  // Ids per column, order-insensitive: renaming or reordering columns doesn't refetch cards.
  const columnsKey = columns.map((c) => `${c.key}:${c.stages.map((st) => st.id).join(',')}`).sort().join('\u0000')
  const waitingForColumns = Boolean(config) && stages == null
  useEffect(() => {
    const listPage = relationOps?.listPage
    if (serverKey == null || !listPage) {
      setServer(null)
      return
    }
    if (waitingForColumns) return
    const opts = JSON.parse(serverKey) as EntityListOptions
    const pinned = opts.filter?.[statusField]
    let cancelled = false
    void Promise.all(
      [...columns, null].map((column) => {
        const ids = column?.stages.map((st) => st.id) ?? []
        // A search-bar filter on the status field itself empties every other column.
        if (pinned != null && column && !ids.includes(pinned)) {
          return Promise.resolve({ records: [], total: 0, totalEstimated: undefined })
        }
        const scope: EntityListOptions =
          column == null
            ? { empty: [statusField] }
            : ids.length === 1
              ? { filter: { [statusField]: ids[0]! } }
              : { in: { [statusField]: ids } }
        return listPage(descriptor.entity, { ...mergeListOptions(opts, scope), pageSize: KANBAN_COLUMN_LIMIT })
      }),
    )
      .then((pages) => {
        if (cancelled) return
        setLoadError(null)
        setServer({
          records: pages.flatMap((p) => p.records) as unknown as T[],
          counts: Object.fromEntries(columnKeys.map((c, i) => [c, pages[i].total])),
          // Go estimates past 10 000 matching rows (ADR-032): shown with "≈".
          estimated: Object.fromEntries(columnKeys.map((c, i) => [c, pages[i].totalEstimated === true])),
        })
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(serializeError(toApiError(e)))
      })
    return () => {
      cancelled = true
    }
  }, [serverKey, columnsKey, waitingForColumns, statusField, descriptor.entity])

  const { records, error, moveField } = useOptimisticFieldMove(server?.records ?? initialData, actions, statusField)
  useEffect(() => {
    onRecordsChange?.(records)
  }, [records, onRecordsChange])
  const [draggingId, setDraggingId] = useState<string | null>(null)

  function statusOf(record: T): string {
    const raw = (record as Record<string, unknown>)[statusField]
    if (typeof raw !== 'string' || raw === '') return NO_STATUS
    // A stage this board didn't load (e.g. another scope's) reads as stage-less.
    return config ? (keyOfId.get(raw) ?? NO_STATUS) : raw
  }

  const [draggingColumn, setDraggingColumn] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<string | null>(null)
  const [newColumn, setNewColumn] = useState('')

  /** A failed column write: show it, put back what was on screen, then re-read the
   * columns (a partly applied reorder leaves the server as the only truth). */
  function columnWriteFailed(previous: RelationRecord[] | null) {
    return (e: unknown) => {
      setColumnError(serializeError(toApiError(e)))
      setStages(previous)
      setStagesVersion((v) => v + 1)
    }
  }

  function dropCard(column: KanbanColumn | null) {
    if (!draggingId) return
    if (!column) return void moveField(draggingId, null)
    if (!config) return void moveField(draggingId, column.key)
    const card = records.find((r) => r.id === draggingId) as Record<string, unknown> | undefined
    const target = resolveDropTarget(column, config.scopeField ? card?.[config.scopeField] : undefined, config)
    if (target == null) {
      setColumnError({ code: 'VALIDATION_ERROR', message: t('No column named {name} exists for this card.').replace('{name}', column.label) })
      return
    }
    setColumnError(null)
    void moveField(draggingId, target)
  }

  function addColumn() {
    const name = newColumn.trim()
    if (!config || !relation || !scopeId || !name || !relationOps) return
    const max = Math.max(0, ...columns.map((c) => c.order))
    setNewColumn('')
    setColumnError(null)
    relationOps
      .create(relation.entity, { [config.labelField]: name, [config.orderField]: max + ORDER_STEP, [config.scopeField!]: scopeId })
      .then((created) => setStages((st) => [...(st ?? []), created]))
      .catch(columnWriteFailed(stages))
  }

  // Enter then blur, or Escape then blur, must not send (a second) PUT.
  const renameSettled = useRef(false)
  function startRename(key: string) {
    renameSettled.current = false
    setRenaming(key)
  }
  function cancelRename() {
    renameSettled.current = true
    setRenaming(null)
  }

  function renameColumn(column: KanbanColumn, value: string) {
    if (renameSettled.current) return
    renameSettled.current = true
    setRenaming(null)
    const name = value.trim()
    if (!config || !relation || !relationOps?.update || !name || name === column.label) return
    setColumnError(null)
    setStages((st) => (st ?? []).map((r) => (r.id === column.key ? { ...r, [config.labelField]: name } : r)))
    relationOps.update(relation.entity, column.key, { [config.labelField]: name }).catch(columnWriteFailed(stages))
  }

  function reorderColumns(dragged: string, before: string) {
    if (!config || !relation || !relationOps?.update || dragged === before) return
    const keys = columns.map((c) => c.key).filter((k) => k !== dragged)
    keys.splice(keys.indexOf(before), 0, dragged)
    const order = new Map(keys.map((k, i) => [k, (i + 1) * ORDER_STEP]))
    const changed = columns.filter((c) => order.get(c.key) !== c.order)
    setColumnError(null)
    setStages((st) => (st ?? []).map((r) => (order.has(r.id) ? { ...r, [config.orderField]: order.get(r.id) } : r)))
    const previous = stages
    // allSettled: re-read only once every PUT has landed, or the re-read could miss some.
    void Promise.allSettled(
      changed.map((c) => relationOps.update!(relation.entity, c.key, { [config.orderField]: order.get(c.key) })),
    ).then((results) => {
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (failed) columnWriteFailed(previous)(failed.reason)
    })
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
      <ErrorAlert error={error} />
      <ErrorAlert error={loadError} />
      <ErrorAlert error={columnError} />
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
        {[...columns, null].map((column) => {
          const key = column?.key ?? NO_STATUS
          const label = column ? column.label : t('No status')
          const cards = records.filter((r) => statusOf(r) === key)
          const count = countOf(key, cards.length)
          const estimated = server?.estimated[key] === true
          const folded = column?.fold === true && !expanded.has(key)
          const heading = `${label} (${formatTotal(count, estimated)})`
          return (
            <Box
              key={key}
              role="group"
              aria-label={label}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                if (draggingColumn) {
                  if (column) reorderColumns(draggingColumn, column.key)
                } else dropCard(column)
              }}
              sx={{
                minWidth: folded ? 0 : 240,
                flex: folded ? '0 0 auto' : '0 0 240px',
                bgcolor: 'action.hover',
                borderRadius: 1,
                p: 1,
              }}
            >
              <Box
                data-testid={`kanban-column-header-${key}`}
                draggable={canEditColumns && column != null}
                onDragStart={() => setDraggingColumn(key)}
                onDragEnd={() => setDraggingColumn(null)}
                sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: folded ? 0 : 1, px: 0.5 }}
              >
                {renaming === key && column ? (
                  <TextField
                    size="small"
                    autoFocus
                    defaultValue={column.label}
                    slotProps={{ htmlInput: { 'aria-label': t('Column name') } }}
                    onBlur={(e) => renameColumn(column, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') renameColumn(column, (e.target as HTMLInputElement).value)
                      if (e.key === 'Escape') cancelRename()
                    }}
                  />
                ) : column?.fold ? (
                  <ButtonBase
                    onClick={() =>
                      setExpanded((s) => {
                        const next = new Set(s)
                        if (next.has(key)) next.delete(key)
                        else next.add(key)
                        return next
                      })
                    }
                    sx={{ borderRadius: 1, justifyContent: 'flex-start' }}
                  >
                    <Typography variant="subtitle2">{heading}</Typography>
                  </ButtonBase>
                ) : (
                  <Typography variant="subtitle2">{heading}</Typography>
                )}
                {canEditColumns && column && renaming !== key ? (
                  <IconButton size="small" aria-label={`${t('Rename column')} ${column.label}`} onClick={() => startRename(key)}>
                    <FontAwesomeIcon icon={byPrefixAndName.fas['pen']} size="xs" />
                  </IconButton>
                ) : null}
              </Box>
              {folded ? null : (
                <>
                  <Stack spacing={1}>
                    {cards.map((record) => (
                      <Card
                        key={record.id}
                        data-testid={`kanban-card-${record.id}`}
                        className="erp-appear"
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
                          {badgeDescriptor && (record as Record<string, unknown>)[badgeDescriptor.name] === true ? (
                            <Chip size="small" color="error" label={t(fieldLabel(badgeDescriptor))} sx={{ mt: 0.5 }} />
                          ) : null}
                        </CardContent>
                      </Card>
                    ))}
                  </Stack>
                  {count > cards.length ? (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, px: 0.5 }}>
                      +{formatTotal(count - cards.length, estimated)} {t('more')}
                    </Typography>
                  ) : null}
                </>
              )}
            </Box>
          )
        })}
        {canEditColumns && relationOps?.create ? (
          <Box sx={{ flex: '0 0 240px', p: 1 }}>
            <TextField
              size="small"
              fullWidth
              placeholder={t('Add column')}
              value={newColumn}
              onChange={(e) => setNewColumn(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addColumn()
              }}
              slotProps={{ htmlInput: { 'aria-label': t('Add column') } }}
            />
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}
