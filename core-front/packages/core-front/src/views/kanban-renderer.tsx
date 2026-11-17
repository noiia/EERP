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
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import { usePermission } from '../auth/Can'
import { usePhone } from './use-phone'
import TextField from '@mui/material/TextField'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import FormControlLabel from '@mui/material/FormControlLabel'
import Typography from '@mui/material/Typography'
import { serializeError, toApiError, type SerializedError } from '../api/errors'
import { mergeListOptions, type EntityListOptions } from '../api/list-options'
import type { KanbanColumnsConfig, KanbanSwimlanesConfig } from '../api/view-fields'
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
import { orderedFields, orderLabel } from './layout-fields'
import { useRelationLabels } from './use-relation-labels'
import { formatTotal } from './total-format'
import { useRelationOps, type RelationRecord } from './relation-ops'
import type { EntityActions, HasId } from './stores'
import { isEmptyZoneClick, useQuickCreate } from './quick-create'
import { useOptimisticFieldMove } from './use-optimistic-field-move'
import { useUiStore } from './ui-store'
import { colorTagsFieldOf, useRecordColors } from './use-record-colors'
import { ColorRibbon } from './color-tags'

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

/** Column records are read this many per page, until a short page. */
const KANBAN_STAGE_PAGE = 200

/** Safety stop: a board past this many column records shows the first ones and says so. */
const KANBAN_STAGE_CEILING = 2000

/** The message (a msgid) shown when a board hits KANBAN_STAGE_CEILING. */
export const TOO_MANY_COLUMNS = 'This board has too many columns: only the first ones are shown.'

/** Orders are rewritten 10, 20, … so a later insert fits between two columns. */
const ORDER_STEP = 10

/** Lane key for the board tasks with no assignment row — never silently dropped. */
const UNASSIGNED_LANE = '__unassigned__'

/** Sentinel lane for a board rendered without swimlanes (the count-key prefix). */
const NO_LANES = '__no_lanes__'

/** In server-paged mode the board's task ids are read this many per page. */
const SWIMLANE_ID_PAGE = 200

/** Safety stop: a board past this many tasks is split by its first ids and says so. */
const SWIMLANE_ID_CAP = 1000

/** Junction rows (and user labels) are read this many ids per request. */
const SWIMLANE_JUNCTION_CHUNK = 100

/** One swimlane: a key (the related record's id, or UNASSIGNED_LANE), its raw
 * label (translated at render) and the board task ids inside it. */
interface Swimlane {
  key: string
  label: string
  ids: string[]
}

/** The union of several (lane, column) pages can share a card (two lanes, one
 * record): keep one entry per id so the working set renders it once. */
function dedupeById(records: RelationRecord[]): RelationRecord[] {
  const seen = new Set<string>()
  return records.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
}

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
  /** Set ⇒ the board can be split into swimlanes over a junction (one lane per
   * related record, e.g. the assignee, plus an Unassigned lane). Off by
   * default; the user's per-entity toggle persists in the UI store. */
  swimlanesConfig?: KanbanSwimlanesConfig
  /** A boolean field: true ⇒ the card shows an error chip labeled with the field's label. */
  badgeField?: string
  /** A color-tags many2many field (ViewModeDefaults.colorTagsField): a 1px ribbon
   * in its colors along each card's top edge. */
  colorTagsField?: string
}

export function KanbanRenderer<T extends HasId>({
  descriptor,
  initialData,
  actions,
  statusField,
  onRecordsChange,
  serverOptions,
  columnsConfig,
  swimlanesConfig,
  badgeField,
  colorTagsField,
}: KanbanRendererProps<T>) {
  const t = useT()
  const router = useRouter()
  const { formPath } = descriptor
  const relationOps = useRelationOps()
  const phone = usePhone()
  const canWrite = usePermission(`${descriptor.entity}:${descriptor.entity}:write`)
  // The per-entity swimlanes toggle, persisted with the other UI preferences.
  const setSwimlanes = useUiStore((s) => s.setSwimlanes)
  const swimlanesOn = swimlanesConfig != null && (useUiStore((s) => s.swimlanes[descriptor.entity]) ?? false)
  const [lanes, setLanes] = useState<Swimlane[] | null>(null)
  const [laneError, setLaneError] = useState<SerializedError | null>(null)
  const [laneTruncated, setLaneTruncated] = useState(false)
  const [laneFolded, setLaneFolded] = useState<Set<string>>(new Set())

  const statusDescriptor = descriptor.fields.find((f) => f.name === statusField)
  const relation = statusDescriptor?.type === 'relation' && statusDescriptor.relation?.kind === 'many2one'
    ? statusDescriptor.relation
    : undefined
  const config = relation ? columnsConfig : undefined
  const options = statusDescriptor?.selection?.options ?? []
  const badgeDescriptor = badgeField ? descriptor.fields.find((f) => f.name === badgeField) : undefined
  // Label field + up to 3 more, skipping the status field itself (redundant
  // with the column a card is already sorted into) and the badge field (a chip).
  const orderField = descriptor.viewModeDefaults?.wbsOrderField
  const shown = orderedFields(descriptor, {
    exclude: [statusField, ...(badgeField ? [badgeField] : []), ...(colorTagsField ? [colorTagsField] : [])],
  })
  // The order field already shows the name ("1.2 - Design"): no second name line.
  const cardFields = (shown.some((f) => f.name === orderField) ? shown.filter((f) => f.name !== 'name' && f.name !== 'title') : shown).slice(0, 4)

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
    // Page until a short page: the total may be an estimate, never a loop bound.
    const loadAll = async () => {
      const all: RelationRecord[] = []
      for (let page = 1; all.length < KANBAN_STAGE_CEILING; page++) {
        const { records } = await listPage(relation.entity, { ...scope, order: config.orderField, page, pageSize: KANBAN_STAGE_PAGE })
        all.push(...records)
        if (records.length < KANBAN_STAGE_PAGE) return { all, truncated: false }
      }
      return { all, truncated: true }
    }
    loadAll()
      .then(({ all, truncated }) => {
        if (cancelled) return
        setStages(all)
        if (truncated) setColumnError({ code: 'TOO_MANY_COLUMNS', message: TOO_MANY_COLUMNS })
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

  // One request per (lane, column): its first KANBAN_COLUMN_LIMIT cards + its
  // total. Without swimlanes that is the plain per-column plan, unchanged.
  const [server, setServer] = useState<{ records: T[]; counts: Record<string, number>; estimated: Record<string, boolean> } | null>(null)
  const [loadError, setLoadError] = useState<SerializedError | null>(null)
  const serverKey = serverOptions && relationOps?.listPage ? JSON.stringify(serverOptions) : null
  // Bumped after a quick create: the columns' cards and counts are read again.
  const [reloads, setReloads] = useState(0)
  // Ids per column, order-insensitive: renaming or reordering columns doesn't refetch cards.
  const columnsKey = columns.map((c) => `${c.key}:${c.stages.map((st) => st.id).join(',')}`).sort().join('\u0000')
  const waitingForColumns = Boolean(config) && stages == null
  // The per-(lane, column) fetches wait for the lanes' membership to load.
  const waitingForLanes = swimlanesOn && lanes == null
  const lanesKey = (lanes ?? []).map((l) => `${l.key}:${l.ids.join(',')}`).sort().join('\u0000')
  useEffect(() => {
    const listPage = relationOps?.listPage
    if (serverKey == null || !listPage) {
      setServer(null)
      return
    }
    if (waitingForColumns || waitingForLanes) return
    const opts = JSON.parse(serverKey) as EntityListOptions
    const pinned = opts.filter?.[statusField]
    let cancelled = false
    const empty = { records: [], total: 0, totalEstimated: undefined as boolean | undefined }
    // The fetch plan: every column of every lane (or the single board when the
    // swimlanes are off). An empty lane settles as empty pages instead of fetching.
    const plan: { lane: Swimlane | null; column: KanbanColumn | null }[] = []
    for (const lane of swimlanesOn && lanes ? lanes : [null]) for (const column of [...columns, null]) plan.push({ lane, column })
    void Promise.all(
      plan.map(({ lane, column }) => {
        const ids = column?.stages.map((st) => st.id) ?? []
        // A search-bar filter on the status field itself empties every other column.
        if (pinned != null && column && !ids.includes(pinned)) {
          return Promise.resolve(empty)
        }
        const scope: EntityListOptions =
          column == null
            ? { empty: [statusField] }
            : ids.length === 1
              ? { filter: { [statusField]: ids[0]! } }
              : { in: { [statusField]: ids } }
        // Swimlane mode scopes the column to the lane's own task ids.
        const inLane = lane && lane.ids.length > 0 ? { in: { id: lane.ids } } : {}
        return listPage(descriptor.entity, { ...mergeListOptions(opts, { ...scope, ...inLane }), pageSize: KANBAN_COLUMN_LIMIT })
      }),
    )
      .then((pages) => {
        if (cancelled) return
        setLoadError(null)
        const counts: Record<string, number> = {}
        const estimated: Record<string, boolean> = {}
        plan.forEach(({ lane, column }, i) => {
          const key = `${lane?.key ?? NO_LANES}\u0000${column?.key ?? NO_STATUS}`
          counts[key] = pages[i]!.total
          // Go estimates past 10 000 matching rows (ADR-032): shown with "≈".
          estimated[key] = pages[i]!.totalEstimated === true
        })
        setServer({
          records: dedupeById(pages.flatMap((p) => p.records)) as unknown as T[],
          counts,
          estimated,
        })
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(serializeError(toApiError(e)))
      })
    return () => {
      cancelled = true
    }
  }, [serverKey, columnsKey, waitingForColumns, waitingForLanes, lanesKey, swimlanesOn, statusField, descriptor.entity, reloads])

  const { records, error, moveField, addRecord } = useOptimisticFieldMove(server?.records ?? initialData, actions, statusField)
  const quick = useQuickCreate(descriptor.entity, serverOptions ?? descriptor.listFilter, (created) => {
    addRecord(created as unknown as T)
    setReloads((n) => n + 1)
  })

  // Swimlane membership: the board's task ids (the working set in client mode,
  // paged and capped in server-paged mode), then the junction rows read in
  // SWIMLANE_JUNCTION_CHUNK-id chunks, then the related records' labels.
  // Read-only by design: a card moves between columns by PATCHing the status
  // field; the junction (and therefore the lanes) is never written.
  const swimlaneKey = swimlanesOn ? JSON.stringify(swimlanesConfig) : null
  // Client mode keys the read on the board's ids; server mode pages the ids
  // itself, so an optimistic move (same ids) must not re-read the junction.
  const laneIdKey = swimlanesOn && serverKey == null ? records.map((r) => r.id).sort().join('\u0000') : ''
  useEffect(() => {
    const list = relationOps?.list
    if (!swimlanesOn || !swimlanesConfig || !list) {
      setLanes(null)
      return
    }
    let cancelled = false
    const load = async () => {
      const cfg = swimlanesConfig
      let ids: string[]
      let truncated = false
      const listPage = relationOps.listPage
      if (serverKey != null && listPage) {
        const opts = JSON.parse(serverKey) as EntityListOptions
        ids = []
        for (let page = 1; ids.length < SWIMLANE_ID_CAP; page++) {
          const { records: pageRecords } = await listPage(descriptor.entity, { ...opts, order: 'id', page, pageSize: SWIMLANE_ID_PAGE })
          ids.push(...pageRecords.map((r) => r.id))
          if (pageRecords.length < SWIMLANE_ID_PAGE) break
        }
        truncated = ids.length >= SWIMLANE_ID_CAP
      } else {
        ids = records.map((r) => r.id)
      }
      const rows: RelationRecord[] = []
      for (let i = 0; i < ids.length; i += SWIMLANE_JUNCTION_CHUNK) {
        rows.push(...(await list(cfg.via, { in: { [cfg.ownField]: ids.slice(i, i + SWIMLANE_JUNCTION_CHUNK) } })))
      }
      const userIds = [...new Set(rows.map((r) => String(r[cfg.relatedField] ?? '')).filter((u) => u !== ''))]
      const users: RelationRecord[] = []
      for (let i = 0; i < userIds.length; i += SWIMLANE_JUNCTION_CHUNK) {
        users.push(...(await list(cfg.entity, { in: { id: userIds.slice(i, i + SWIMLANE_JUNCTION_CHUNK) } })))
      }
      const tasksByUser = new Map<string, Set<string>>()
      const assigned = new Set<string>()
      for (const row of rows) {
        const userId = String(row[cfg.relatedField] ?? '')
        const taskId = String(row[cfg.ownField] ?? '')
        if (!userId || !taskId) continue
        assigned.add(taskId)
        if (!tasksByUser.has(userId)) tasksByUser.set(userId, new Set())
        tasksByUser.get(userId)!.add(taskId)
      }
      const labelById = new Map(users.map((u) => [u.id, u]))
      const laneList: Swimlane[] = []
      for (const [userId, tasks] of tasksByUser) {
        const user = labelById.get(userId)
        laneList.push({ key: userId, label: user ? String(user[cfg.labelField] ?? userId) : userId, ids: [...tasks] })
      }
      laneList.sort((a, b) => a.label.localeCompare(b.label))
      laneList.push({ key: UNASSIGNED_LANE, label: 'Unassigned', ids: ids.filter((id) => !assigned.has(id)) })
      if (!cancelled) {
        setLanes(laneList)
        setLaneTruncated(truncated)
        setLaneError(null)
      }
    }
    void load().catch((e: unknown) => {
      if (!cancelled) setLaneError(serializeError(toApiError(e)))
    })
    return () => {
      cancelled = true
    }
  }, [swimlanesOn, swimlaneKey, serverKey, laneIdKey, descriptor.entity, reloads])

  /** A click on a column's empty space: create a card in that column. A merged
   * many2one column (several scopes' stages) leaves the status to the form. */
  function onColumnClick(event: React.MouseEvent, column: KanbanColumn | null) {
    if (!quick.canCreate || !isEmptyZoneClick(event)) return
    const status = !column ? undefined : !config ? column.key : column.stages.length === 1 ? column.stages[0]!.id : undefined
    quick.open(status === undefined ? {} : { [statusField]: status })
  }
  const { colors } = useRecordColors(descriptor.entity, colorTagsFieldOf(descriptor as ViewDescriptor, colorTagsField), records.map((r) => r.id))
  const labelOf = useRelationLabels(
    cardFields,
    records.flatMap((r) => cardFields.map((f): [string, unknown] => [f.name, (r as Record<string, unknown>)[f.name]])),
  )
  useEffect(() => {
    onRecordsChange?.(records)
  }, [records, onRecordsChange])
  const [draggingId, setDraggingId] = useState<string | null>(null)
  // Phone: the card whose "Move to" menu is open (HTML5 drag never fires on touch).
  const [moving, setMoving] = useState<{ id: string; anchor: HTMLElement } | null>(null)

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

  function dropCard(column: KanbanColumn | null, id: string) {
    if (!column) return void moveField(id, null)
    if (!config) return void moveField(id, column.key)
    const card = records.find((r) => r.id === id) as Record<string, unknown> | undefined
    const target = resolveDropTarget(column, config.scopeField ? card?.[config.scopeField] : undefined, config)
    if (target == null) {
      setColumnError({ code: 'VALIDATION_ERROR', message: t('No column named {name} exists for this card.').replace('{name}', column.label) })
      return
    }
    setColumnError(null)
    void moveField(id, target)
  }

  /** The first card field's text, which names a card to a screen reader. */
  function moveLabel(record: T): string {
    const f = cardFields[0]
    if (!f) return ''
    const rec = record as Record<string, unknown>
    return orderLabel(descriptor, f.name, rec) ?? labelOf(f.name, rec[f.name])
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

  /** The column's full count in its lane: the server total, shifted by any
   * cards dragged in or out since it loaded. Without server data, the shown. */
  function countOf(lane: Swimlane | null, columnKey: string, shown: number): number {
    if (!server) return shown
    const laneIds = lane ? new Set(lane.ids) : null
    const loaded = server.records.filter((r) => (laneIds ? laneIds.has(r.id) : true) && statusOf(r) === columnKey).length
    return (server.counts[`${lane?.key ?? NO_LANES}\u0000${columnKey}`] ?? 0) + shown - loaded
  }

  /** A lane's full count: every column's server total inside the lane (the
   * columns are disjoint, so the totals sum to the lane), shifted the same way. */
  function laneCountOf(lane: Swimlane, shown: number): number {
    if (!server) return shown
    const laneIds = new Set(lane.ids)
    const total = columnKeys.reduce((sum, c) => sum + (server.counts[`${lane.key}\u0000${c}`] ?? 0), 0)
    const loaded = server.records.filter((r) => laneIds.has(r.id)).length
    return total + shown - loaded
  }

  const movingRecord = moving ? records.find((r) => r.id === moving.id) : undefined
  const currentKey = movingRecord ? statusOf(movingRecord) : undefined

  /** One board column (the whole board, or inside a swimlane). `lane` scopes the
   * cards to that lane's ids; inside lanes the column header's testid is
   * prefixed with the lane key so the duplicated testids stay queryable. */
  function renderBoardColumn(column: KanbanColumn | null, lane: Swimlane | null, laneIds: Set<string> | null) {
    const key = column?.key ?? NO_STATUS
    const label = column ? column.label : t('No status')
    const cards = records.filter((r) => statusOf(r) === key && (laneIds ? laneIds.has(r.id) : true))
    const count = countOf(lane, key, cards.length)
    const estimated = server?.estimated[`${lane?.key ?? NO_LANES}\u0000${key}`] === true
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
          } else if (draggingId) dropCard(column, draggingId)
        }}
        onClick={folded ? undefined : (e) => onColumnClick(e, column)}
        sx={{
          minWidth: folded || phone ? 0 : 240,
          flex: folded ? '0 0 auto' : phone ? '0 0 85%' : '0 0 240px',
          ...(phone && !folded && { scrollSnapAlign: 'start' }),
          bgcolor: 'action.hover',
          borderRadius: 1,
          p: 1,
        }}
      >
        <Box
          data-testid={`kanban-column-header-${lane ? `${lane.key}-` : ''}${key}`}
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
                  sx={{ cursor: formPath ? 'pointer' : 'grab', position: 'relative' }}
                >
                  <ColorRibbon colors={colors.get(record.id)} />
                  <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                    {phone && canWrite ? (
                      <IconButton
                        aria-label={`${t('Move')} ${moveLabel(record)}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          setMoving({ id: record.id, anchor: e.currentTarget })
                        }}
                        sx={{ float: 'right', width: 40, height: 40, mt: -0.5, mr: -0.5 }}
                      >
                        <FontAwesomeIcon icon={byPrefixAndName.fas['arrows-up-down-left-right']} size="sm" />
                      </IconButton>
                    ) : null}
                    {cardFields.map((f, i) => (
                      <Typography
                        key={f.name}
                        variant={i === 0 ? 'body2' : 'caption'}
                        sx={{ display: 'block', fontWeight: i === 0 ? 600 : 400 }}
                      >
                        {orderLabel(descriptor, f.name, record as Record<string, unknown>) ?? labelOf(f.name, (record as Record<string, unknown>)[f.name])}
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
  }

  return (
    <Box>
      <ErrorAlert error={error} />
      <ErrorAlert error={loadError} />
      {quick.dialog}
      <ErrorAlert error={columnError} />
      {swimlanesConfig ? (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
          <FormControlLabel
            control={<Switch size="small" checked={swimlanesOn} onChange={(_e, checked) => setSwimlanes(descriptor.entity, checked)} />}
            label={`${t('Swimlanes')}: ${t(swimlanesConfig.label)}`}
          />
        </Box>
      ) : null}
      <ErrorAlert error={laneError} />
      {swimlanesOn && laneTruncated ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          {t('First 1000 shown')}
        </Typography>
      ) : null}
      {swimlanesOn && lanes ? (
        // One row of the usual columns per lane, stacked: a card with several
        // related records shows once per lane, and a lane collapse hides its row.
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }} data-testid="kanban-lanes">
          {lanes.map((lane) => {
            const laneIds = new Set(lane.ids)
            const shown = records.filter((r) => laneIds.has(r.id)).length
            const folded = laneFolded.has(lane.key)
            return (
              <Box key={lane.key} data-testid={`kanban-lane-${lane.key}`}>
                <ButtonBase
                  onClick={() =>
                    setLaneFolded((s) => {
                      const next = new Set(s)
                      if (next.has(lane.key)) next.delete(lane.key)
                      else next.add(lane.key)
                      return next
                    })
                  }
                  sx={{ display: 'flex', justifyContent: 'flex-start', width: '100%', bgcolor: 'action.hover', borderRadius: 1, px: 1.5, py: 0.5, mb: 0.5 }}
                >
                  <Typography variant="subtitle2">{`${t(lane.label)} (${formatTotal(laneCountOf(lane, shown), false)})`}</Typography>
                </ButtonBase>
                {folded ? null : (
                  <Box
                    data-testid={`kanban-lane-row-${lane.key}`}
                    sx={{ display: 'flex', gap: 2, overflowX: 'auto', pb: 1, alignItems: 'flex-start', ...(phone && { scrollSnapType: 'x mandatory' }) }}
                    style={{ justifyContent: 'safe center' }}
                  >
                    {[...columns, null].map((column) => renderBoardColumn(column, lane, laneIds))}
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>
      ) : (
        <Box
          sx={{ display: 'flex', gap: 2, overflowX: 'auto', pb: 1, alignItems: 'flex-start', ...(phone && { scrollSnapType: 'x mandatory' }) }}
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
          {[...columns, null].map((column) => renderBoardColumn(column, null, null))}
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
      )}
      {moving ? (
        <Menu open anchorEl={moving.anchor} onClose={() => setMoving(null)}>
          {[...columns, null]
            .filter((column) => (column?.key ?? NO_STATUS) !== currentKey)
            .map((column) => (
              <MenuItem
                key={column?.key ?? NO_STATUS}
                onClick={() => {
                  setMoving(null)
                  dropCard(column, moving.id)
                }}
              >
                {column ? column.label : t('No status')}
              </MenuItem>
            ))}
        </Menu>
      ) : null}
    </Box>
  )
}
