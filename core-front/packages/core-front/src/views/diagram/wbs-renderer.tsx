'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Checkbox from '@mui/material/Checkbox'
import ListItemText from '@mui/material/ListItemText'
import Menu from '@mui/material/Menu'
import MenuItem from '@mui/material/MenuItem'
import Typography from '@mui/material/Typography'
import { MarkerType, Position, type Connection, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { serializeError, toApiError, type SerializedError } from '../../api/errors'
import type { WbsDeliverablesConfig } from '../../api/view-fields'
import type { EntityListOptions } from '../../api/list-options'
import { usePermission } from '../../auth/Can'
import { useT } from '../../i18n/translate'
import { erpPath } from '../../navigation'
import type { FieldDescriptor, ViewDescriptor } from '../descriptor'
import { ErrorAlert } from '../error-alert'
import { useNumberFormat } from '../format-store'
import type { EntityActions, HasId } from '../stores'
import { useRelationLabels } from '../use-relation-labels'
import { useRelationOps } from '../relation-ops'
import { layoutWbs } from './auto-layout'
import { DELIVERABLE_BOX_SIZE, type DeliverableBoxData } from './deliverable-box'
import { DiagramCanvas, DiagramCapNotice, DiagramLoading, useDiagramRecords } from './diagram-canvas'
import { ToolButton } from './toolbar'
import { useUndoHistory } from './history'
import type { Point } from './collide'
import { colorTagsFieldOf, useRecordColors } from '../use-record-colors'
import { boxFieldOf, LABEL_BOX_SIZE, STACK_HANDLE, TASK_BOX_SIZE, type LabelBoxData, type TaskBoxData } from './task-box'
import { buildWbs, canReparent } from './wbs'

// WBS display mode: the records as a top-down tree over `parentField`, under one
// read-only root per `groupField` value. Boxes edit their fields in place, parents
// fold (the folds ride the canvas's saved layout), and a box dropped on another one
// is re-parented there (on a group root: parent cleared). The lines are the parent
// links: drawing one from a box's bottom to another's top makes the first the parent,
// deleting one clears the child's parent, dragging an end moves the link. The server
// renumbers the order after each, so the records are read again.

const FOLDED_COLOR = '#ed6c02'
const GROUP = 'group:'
/** The row the deliverable footer sits on: this far below the lowest drawn box. */
const DELIVERABLE_FOOTER_GAP = 48
/** Between a task and the milestone tile under it. */
const DELIVERABLE_GAP = 24
const DELIVERABLE = 'deliverable:'
/** Item ids per `in[id]=` read (the same chunk size the relation labels use). */
const DELIVERABLE_CHUNK = 100
/** From this task level on (1 = a top task, so `1.1.1`), children stack vertically under their
 * parent, each joined by an elbow from the parent's left side — except a level-3 family showing
 * level-4 tasks, which spreads in a row of column headers. */
const STACK_LEVEL = 3
/** The Layers menu's names for levels 1, 2, 3…: "Layer X", "Layer X.Y", "Layer X.Y.Z". */
const LAYER_LETTERS = 'XYZWVUTS'
export const layerName = (level: number) => Array.from({ length: level }, (_, i) => LAYER_LETTERS[i % LAYER_LETTERS.length]).join('.')

export interface WbsRendererProps<T extends HasId> {
  descriptor: ViewDescriptor
  initialData: T[]
  actions: EntityActions<T>
  parentField: string
  groupField?: string
  /** Fields edited in each box, in order (unknown names and duplicates dropped). Default: name. */
  boxFields?: (string | null | undefined)[]
  /** A number field summed into a folded box's footer. */
  hoursField?: string
  /** The dotted order number field (`wbsOrderField`): siblings drawn in its order, and a
   * dropped box writes its new number from where it lands among its (new) siblings. */
  orderField?: string
  /** Deliverables (`wbsDeliverables`): each task's milestone under it, level-1 ones on a
   * footer row (empty placeholder when none). */
  deliverables?: WbsDeliverablesConfig
  onRecordsChange?: (records: T[]) => void
  serverOptions?: EntityListOptions
  /** ViewModeDefaults.colorTagsField: each box shows its color groups as a bar along its top. */
  colorTagsField?: string
}

export function WbsRenderer<T extends HasId>({
  descriptor,
  initialData,
  actions,
  parentField,
  groupField,
  boxFields = ['name'],
  hoursField,
  orderField,
  deliverables,
  onRecordsChange,
  serverOptions,
  colorTagsField,
}: WbsRendererProps<T>) {
  const t = useT()
  const router = useRouter()
  const { format } = useNumberFormat()
  const { entity, formPath } = descriptor
  const canWrite = usePermission(`${entity}:${entity}:write`)
  const loaded = useDiagramRecords(entity, serverOptions, initialData)
  const [rows, setRows] = useState(loaded.records)
  const { colors } = useRecordColors(entity, colorTagsFieldOf(descriptor, colorTagsField), rows.map((r) => r.id))
  const [seen, setSeen] = useState(loaded.records)
  if (seen !== loaded.records) {
    setSeen(loaded.records)
    setRows(loaded.records)
  }
  useEffect(() => {
    onRecordsChange?.(rows)
  }, [rows, onRecordsChange])
  const [folded, setFolded] = useState<string[]>([])
  const [error, setError] = useState<SerializedError | null>(null)
  // Undo/redo of moves, parent and order changes, insertions and box edits.
  const history = useUndoHistory((e) => setError(serializeError(toApiError(e))))

  const fieldOf = boxFieldOf(descriptor)
  const fields = [...new Set(boxFields.filter((n): n is string => !!n))]
    .map(fieldOf)
    .filter((f): f is FieldDescriptor => !!f)
  // Many2one labels for the export's printed boxes, read once for the whole diagram.
  const relationLabel = useRelationLabels(
    fields,
    rows.flatMap((r) => fields.map((f): [string, unknown] => [f.name, (r as unknown as Record<string, unknown>)[f.name]])),
  )
  const groupDescriptor = groupField ? fieldOf(groupField) : undefined

  const values = (r: T) => r as unknown as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)
  const foldedSet = new Set(folded)
  const inputs = rows.map((r) => ({
    id: r.id,
    parentId: str(values(r)[parentField]),
    groupId: groupField ? str(values(r)[groupField]) : null,
    order: orderField ? str(values(r)[orderField]) : null,
    plannedHours: hoursField ? Number(values(r)[hoursField]) || 0 : 0,
  }))
  const { nodes, roots, visible } = buildWbs(inputs, foldedSet)
  // A task's level: 1 under a group root or at the top, its parent's + 1 below that.
  const levels = new Map<string, number>()
  const levelOf = (id: string): number => {
    if (nodes[id].kind !== 'task') return 0
    if (!levels.has(id)) {
      const p = nodes[id].parentId
      levels.set(id, 1 + (p && nodes[p].kind === 'task' ? levelOf(p) : 0))
    }
    return levels.get(id)!
  }
  const shown = new Set(visible)
  // Level 3 stacks unless one of its siblings shows level-4 children: then the level-3 siblings
  // spread side by side as column headers, each with its children stacked under it.
  const stacked = (id: string) => {
    const level = levelOf(id)
    if (level !== STACK_LEVEL) return level > STACK_LEVEL
    return !nodes[nodes[id].parentId!].children.some((s) => nodes[s].children.some((c) => shown.has(c)))
  }

  // ---- Layers menu: one checkbox per task level. Level k shows while every box of level
  // k-1 (0 = the group roots) that has children is unfolded; unticking it folds them all,
  // ticking it unfolds every box above it. The folds are the canvas's own, so the export
  // and the saved layout follow.
  const [layersAnchor, setLayersAnchor] = useState<HTMLElement | null>(null)
  const parentsAt = (level: number) => Object.keys(nodes).filter((id) => nodes[id].children.length && levelOf(id) === level)
  const maxLevel = Math.max(0, ...Object.keys(nodes).map(levelOf))
  const layers = Array.from({ length: maxLevel }, (_, i) => {
    const level = i + 1
    const above = Object.keys(nodes).filter((id) => nodes[id].children.length && levelOf(id) < level)
    const own = parentsAt(level - 1)
    const shut = above.filter((id) => foldedSet.has(id)).length
    return { level, checked: shut === 0, indeterminate: shut > 0 && own.some((id) => !foldedSet.has(id)), disabled: own.length === 0, own, above }
  })
  const toggleLayer = (l: (typeof layers)[number]) =>
    setFolded((f) => (l.checked ? [...new Set([...f, ...l.own])] : f.filter((id) => !l.above.includes(id))))
  const groupIds = roots.filter((id) => id.startsWith(GROUP))
  const labelOf = useRelationLabels(
    groupDescriptor ? [groupDescriptor] : [],
    groupIds.map((id): [string, unknown] => [groupField!, id.slice(GROUP.length)]),
  )

  const replace = (updated: T) => setRows((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)))
  const toggle = (id: string) => setFolded((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]))
  const footer = (id: string) =>
    foldedSet.has(id) ? (
      <Typography variant="caption" sx={{ color: FOLDED_COLOR, display: 'block', mt: 0.5 }}>
        {(nodes[id].hiddenCount === 1 ? t('+1 task · {h} h') : t('+{n} tasks · {h} h'))
          .replace('{n}', String(nodes[id].hiddenCount))
          .replace('{h}', format(Math.round(nodes[id].hiddenHours * 100) / 100))}
      </Typography>
    ) : undefined
  const chevron = (id: string) =>
    nodes[id].children.length ? { folded: foldedSet.has(id), onToggle: () => toggle(id) } : undefined

  const byId = new Map(rows.map((r) => [r.id, r]))
  // The zoomed-out box title: "<order> - <name>" like the lists.
  const titleOf = (r: T) => [orderField ? str(values(r)[orderField]) : null, str(values(r).name) ?? str(values(r).title)].filter(Boolean).join(' - ')

  // ---- Deliverables (ADR-039): each task's milestone (`deliverables.field`) as a tile under
  // it, an arrow from the task; a level-1 task's on one footer row below the diagram, aligned
  // on its column — an empty placeholder (opening the creation form) when it has none.
  const deliverableOf = (id: string) => (deliverables && nodes[id]?.kind === 'task' ? str(values(byId.get(id)!)[deliverables.field]) : null)
  const isTopTask = (id: string) => nodes[id].kind === 'task' && (!nodes[id].parentId || nodes[id].parentId!.startsWith(GROUP))
  const allDeliverableIds = useMemo(
    () => (deliverables ? [...new Set(rows.map((r) => str(values(r)[deliverables.field])).filter((v): v is string => !!v))].sort() : []),
    [deliverables, rows],
  )
  const ops = useRelationOps()
  // null = not read yet, or the read was refused: then no tile at all, no error.
  const [deliverableRows, setDeliverableRows] = useState<Record<string, unknown>[] | null>(null)
  const deliverableEntity = deliverables?.entity
  const deliverableKey = allDeliverableIds.join('\n')
  // One read per set of ids (`in[id]=`, chunks of DELIVERABLE_CHUNK): a move never re-reads.
  useEffect(() => {
    if (!deliverableEntity || !ops) {
      setDeliverableRows(null)
      return
    }
    if (!deliverableKey) {
      setDeliverableRows([])
      return
    }
    const ids = deliverableKey.split('\n')
    let cancelled = false
    const found: Record<string, unknown>[] = []
    ;(async () => {
      for (let i = 0; i < ids.length; i += DELIVERABLE_CHUNK) {
        const chunk = ids.slice(i, i + DELIVERABLE_CHUNK)
        found.push(...(await ops.list(deliverableEntity, { in: { id: chunk }, pageSize: chunk.length })))
      }
      if (!cancelled) setDeliverableRows(found)
    })().catch(() => {
      if (!cancelled) setDeliverableRows(null)
    })
    return () => {
      cancelled = true
    }
  }, [ops, deliverableEntity, deliverableKey])
  const deliverableById = new Map((deliverableRows ?? []).map((r) => [String(r.id), r]))
  const deliverablesReady = !!deliverables && deliverableRows !== null
  // A task whose milestone tile sits right under it (a non-level-1 one with a known milestone).
  const tiled = (id: string) => deliverablesReady && !isTopTask(id) && deliverableById.has(deliverableOf(id) ?? '')
  // The layout keeps room for that tile, so the next row starts below it.
  const heightOf = (id: string) =>
    nodes[id].kind === 'group' ? LABEL_BOX_SIZE.h : TASK_BOX_SIZE.h + (tiled(id) ? DELIVERABLE_GAP + DELIVERABLE_BOX_SIZE.h : 0)
  const openForm = (path: string) => router.push(erpPath(path))
  const deliverableNode = (id: string, x: number, y: number, task: string): Node => {
    const d = deliverables!
    const mid = deliverableOf(id)
    const r = mid ? deliverableById.get(mid) : undefined
    const record = values(byId.get(id)!)
    const hasCounts = !!d.doneField && !!d.totalField
    let onOpen = () => openForm(d.formPath.replace(':id', mid!))
    if (!r) {
      // The creation form, seeded with the task's project and linked back to the task once saved.
      const q = new URLSearchParams()
      const scope = groupField ? str(record[groupField]) : null
      if (scope) q.set(`filter[${groupField}]`, scope)
      q.set('link', `${entity}:${id}:${d.field}`)
      onOpen = () => openForm(`${d.formPath.replace(':id', 'new')}?${q.toString()}`)
    }
    const data: DeliverableBoxData = {
      label: r ? String(r[d.labelField] ?? r.name ?? mid) : null,
      taskName: task,
      counts: r && hasCounts ? `${Number(r[d.doneField!]) || 0} / ${Number(r[d.totalField!]) || 0}` : undefined,
      onOpen,
    }
    return { id: `${DELIVERABLE}${id}`, type: 'deliverable', position: { x: x + TASK_BOX_SIZE.w / 2 - DELIVERABLE_BOX_SIZE.w / 2, y }, width: DELIVERABLE_BOX_SIZE.w, height: DELIVERABLE_BOX_SIZE.h, data }
  }
  // Positioned from the final placed boxes on every render (never stored), so a tile follows
  // its task through a move, a re-arrange and an undo alike.
  const extraDeliverableNodes = (positions: Record<string, Point>): Node[] => {
    if (!deliverablesReady) return []
    const under = visible.filter(tiled).map((id) => deliverableNode(id, positions[id]!.x, positions[id]!.y + TASK_BOX_SIZE.h + DELIVERABLE_GAP, titleOf(byId.get(id)!)))
    const heads = visible.filter(isTopTask)
    if (!heads.length) return under
    const bottom = Math.max(...visible.map((id) => positions[id]!.y + heightOf(id)))
    const row = bottom + DELIVERABLE_FOOTER_GAP
    return [...under, ...heads.map((id) => deliverableNode(id, positions[id]!.x, row, str(values(byId.get(id)!).name) ?? titleOf(byId.get(id)!)))]
  }
  // The arrows to the tiles right under their task (the footer ones are aligned instead: an
  // arrow down a whole column would cross its boxes).
  const deliverableEdges: Edge[] = visible.filter(tiled).map((id) => ({
    id: `${DELIVERABLE}edge:${id}`,
    source: id,
    target: `${DELIVERABLE}${id}`,
    markerEnd: { type: MarkerType.ArrowClosed },
    deletable: false,
    reconnectable: false,
    selectable: false,
    focusable: false,
  }))
  const rfNodes: Node[] = visible.map((id) => {
    if (nodes[id].kind === 'group') {
      const data: LabelBoxData = { label: labelOf(groupField!, id.slice(GROUP.length)), chevron: chevron(id), footer: footer(id) }
      return { id, type: 'label', position: { x: 0, y: 0 }, width: LABEL_BOX_SIZE.w, height: LABEL_BOX_SIZE.h, data }
    }
    const record = byId.get(id)!
    const data: TaskBoxData = {
      record: values(record),
      title: titleOf(record),
      editable: canWrite,
      fields,
      onCommit: async (field, value) => {
        const old = values(record)[field]
        const set = async (v: unknown) => replace(await actions.update(id, { [field]: v } as Partial<T>))
        await set(value)
        history.push({ undo: () => set(old), redo: () => set(value) })
      },
      onOpen: () => {
        if (formPath) router.push(erpPath(formPath.replace(':id', id)))
      },
      chevron: chevron(id),
      footer: footer(id),
      colors: colors.get(id),
      relationLabel,
    }
    return { id, position: { x: 0, y: 0 }, data, ...(stacked(id) ? { targetPosition: Position.Left } : {}) }
  })
  const edges: Edge[] = [...deliverableEdges, ...visible.flatMap((id) => {
    const p = nodes[id].parentId
    // A group root's line isn't a parent link: it can't be deleted or moved.
    const link = canWrite && !p?.startsWith(GROUP)
    if (!p || !shown.has(p)) return []
    // A stacked child: an elbow down the parent's left side, then right into the child.
    const elbow = stacked(id) ? { type: 'step', sourceHandle: STACK_HANDLE } : {}
    return [{ id: `${p}->${id}`, source: p, target: id, deletable: link, reconnectable: link, ...elbow }]
  })]

  const groupOf = (target: string) =>
    target.startsWith(GROUP) ? target.slice(GROUP.length) : str(values(byId.get(target)!)[groupField!])
  // Makes `parent` (a task, a group root or null = none) the parent of `child`; false when refused or unchanged.
  const setParent = (child: string, parent: string | null): Promise<boolean> | false => {
    if (!canWrite || nodes[child]?.kind !== 'task' || !canReparent(nodes, child, parent)) return false
    if (groupField && parent && groupOf(parent) !== groupOf(child)) return false
    const value = parent && !parent.startsWith(GROUP) ? parent : null
    if (value === str(values(byId.get(child)!)[parentField])) return false
    setError(null)
    const back = restore(child)
    return actions.update(child, { [parentField]: value } as Partial<T>).then(
      (updated) => {
        replace(updated)
        // Siblings and descendants were renumbered too.
        if (orderField) loaded.reload()
        history.push({ undo: () => write(child, back), redo: () => write(child, { [parentField]: value }) })
        return true
      },
      (e: unknown) => {
        setError(serializeError(toApiError(e)))
        return false
      },
    )
  }
  // Writes a record as an undo/redo step does: no checks (they ran when the step was first
  // taken), the tree read again when order numbers may have moved.
  const write = async (id: string, patch: Record<string, unknown>) => {
    replace(await actions.update(id, patch as Partial<T>))
    if (orderField) loaded.reload()
  }
  // What puts a record back where it is now: its order number (it names the parent and the
  // position), else its parent.
  const restore = (id: string): Record<string, unknown> => {
    const r = values(byId.get(id)!)
    const code = orderField ? str(r[orderField]) : null
    return code !== null ? { [orderField!]: code } : { [parentField]: str(r[parentField]) }
  }

  // A task with no parent and no child dropped across a parent line P → C goes in between:
  // it takes C's place under P (its number, with order numbers) and C goes under it.
  const canInsert = (id: string, e: Edge) =>
    canWrite && nodes[id]?.kind === 'task' && !e.source.startsWith(GROUP) &&
    str(values(byId.get(id)!)[parentField]) === null && nodes[id].children.length === 0 &&
    (!groupField || groupOf(e.source) === groupOf(id))
  const onInsert = (id: string, { source: p, target: c }: Edge) => {
    const backC = restore(c)
    const place = orderField && str(values(byId.get(c)!)[orderField]) !== null ? backC : { [parentField]: p }
    setError(null)
    void history.perform(
      async () => {
        await write(id, place)
        await write(c, { [parentField]: id })
      },
      async () => {
        await write(c, backC)
        await write(id, { [parentField]: null })
      },
    )
  }

  const onConnect = ({ source, target }: Connection) => void setParent(target, source)
  const onEdgesDelete = (deleted: Edge[]) => {
    for (const e of deleted) void setParent(e.target, null)
  }
  // The child end moved: the new box takes the parent and the old one loses it.
  const onReconnect = (old: Edge, { source, target }: Connection) => {
    const done = setParent(target, source)
    if (target !== old.target && done) void done.then((ok) => ok && setParent(old.target, null))
  }

  // The order number a box dropped under `parent` takes: one past the siblings left of it.
  const orderAt = (id: string, parent: string | null, at: Record<string, { x: number }>): string | null => {
    const parentCode = parent && !parent.startsWith(GROUP) ? str(values(byId.get(parent)!)[orderField!]) : ''
    if (parentCode === null) return null
    const siblings = parent ? nodes[parent].children : roots
    const pos = 1 + siblings.filter((s) => s !== id && at[s] && at[s].x < at[id].x).length
    return parentCode ? `${parentCode}.${pos}` : String(pos)
  }

  // false puts the box back where it was (DiagramCanvas.onNodeDrop).
  const onNodeDrop = (id: string, overId: string | null, at: Record<string, { x: number }>): boolean | Promise<boolean> => {
    const ordered = orderField && canWrite && nodes[id]?.kind === 'task'
    // Dropped on empty space: with order numbers, a move among its own siblings.
    if (overId === null && !ordered) return true
    const parent = overId ?? nodes[id].parentId
    // Read-only, or another group (moving between groups isn't a WBS drag).
    if (!canWrite || (overId !== null && !canReparent(nodes, id, overId))) return false
    if (!ordered && overId === nodes[id]?.parentId) return false
    if (groupField && parent && groupOf(parent) !== groupOf(id)) return false
    const code = ordered ? orderAt(id, parent, at) : null
    if (ordered && code !== null && code === str(values(byId.get(id)!)[orderField])) return true
    if (overId === null && code === null) return true
    setError(null)
    // A number names the parent too (the server resolves it); without one, the parent alone.
    const patch = code !== null ? { [orderField!]: code } : { [parentField]: parent && !parent.startsWith(GROUP) ? parent : null }
    const back = restore(id)
    return actions.update(id, patch as Partial<T>).then(
      (updated) => {
        replace(updated)
        // Siblings and descendants were renumbered too.
        if (ordered) loaded.reload()
        history.push({ undo: () => write(id, back), redo: () => write(id, patch) })
        return true
      },
      (e: unknown) => {
        setError(serializeError(toApiError(e)))
        return false
      },
    )
  }

  if (loaded.capped) return <DiagramCapNotice />
  if (loaded.loading) return <DiagramLoading />
  return (
    <>
      <ErrorAlert error={error ?? (loaded.error ? { code: 'INTERNAL_ERROR', message: loaded.error } : null)} />
      <DiagramCanvas
        entity={entity}
        mode="wbs"
        title={t('WBS')}
        nodes={rfNodes}
        edges={edges}
        extraNodes={extraDeliverableNodes}
        autoLayout={() => layoutWbs(nodes, roots, visible, TASK_BOX_SIZE, heightOf, stacked)}
        folded={folded}
        onFoldedChange={setFolded}
        onNodeDrop={onNodeDrop}
        onConnect={canWrite ? onConnect : undefined}
        onEdgesDelete={canWrite ? onEdgesDelete : undefined}
        onReconnect={canWrite ? onReconnect : undefined}
        onInsert={canWrite ? onInsert : undefined}
        canInsert={canInsert}
        history={history}
        legend={[{ color: FOLDED_COLOR, label: t('Folded branch') }]}
        toolbarExtra={
          layers.length ? (
            <ToolButton icon="layer-group" label={t('Layers')} aria-haspopup="menu" onClick={(e) => setLayersAnchor(e.currentTarget)} />
          ) : undefined
        }
      />
      <Menu
        open={!!layersAnchor}
        onClose={() => setLayersAnchor(null)}
        anchorEl={layersAnchor}
        data-testid="wbs-layers-menu"
      >
        {layers.map((l) => (
          <MenuItem key={l.level} dense disabled={l.disabled} onClick={() => toggleLayer(l)}>
            <Checkbox size="small" checked={l.checked} indeterminate={!l.checked && l.indeterminate} tabIndex={-1} sx={{ p: 0.5, mr: 1 }} />
            <ListItemText primary={t('Layer {n}').replace('{n}', layerName(l.level))} />
          </MenuItem>
        ))}
      </Menu>
    </>
  )
}
