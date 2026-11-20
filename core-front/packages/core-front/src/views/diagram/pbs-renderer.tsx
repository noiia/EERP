import { useEffect, useMemo, useRef, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControl from '@mui/material/FormControl'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import { usePathname, useRouter } from 'next/navigation'
import { Position, type Connection, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { serializeError, toApiError, type SerializedError } from '../../api/errors'
import type { PbsConfig } from '../../api/view-fields'
import { useT } from '../../i18n/translate'
import { BannerScope, BannerSlot } from '../banner'
import { ErrorAlert } from '../error-alert'
import { kanbanColumnsGuard } from '../kanban-columns'
import { useRelationOps, type RelationRecord } from '../relation-ops'
import { layoutTreeGrid, treeGridEdges } from './auto-layout'
import type { Point } from './collide'
import { DIAGRAM_RECORD_CAP, DiagramCapNotice, DiagramCanvas, DiagramLoading } from './diagram-canvas'
import { ToolButton } from './toolbar'
import { useUndoHistory } from './history'
import { PBS_BOX_SIZE, type PbsBoxData, type PbsRow } from './pbs-box'
import { buildWbs } from './wbs'

export { PBS_BOX_SIZE }

// PBS display mode: the pinned project's deliverables (project_pbs_item rows), drawn
// as a shared chart of colored boxes, one box per deliverable, lines from each box to
// its parent. Each box shows the progress of the tasks producing it (rolled up over
// the box's descendants); the counts come from one paged read of the project's tasks
// grouped by pbs_item_id — the rows' stored task_count/done_count stand in when that
// read is capped. Positions are the rows' own x/y (controlled canvas); an item never
// placed (0, 0) takes the tree layout's spot. Writes need the guard named by
// config.canEdit; Go re-checks each one.

const PAGE_SIZE = 200
const TASK_ENTITY = 'project_task'
// Past this many tasks the roll-up can't be trusted; the stored counts stand in.
const TASK_CAP = 1000

type TaskRow = { id: string; pbs_item_id: string | null; closed: boolean }
type Count = { done: number; total: number }
interface Draft { row?: PbsRow; spot?: Point }

export interface PbsRendererProps {
  config: PbsConfig
  projectId: string
}

const savedPositions = (rows: PbsRow[]) =>
  Object.fromEntries(rows.filter((r) => r.x || r.y).map((r) => [r.id, { x: r.x, y: r.y }]))

// The counts shown per item: one read of the project's tasks (paged), grouped by the
// task's pbs_item_id and rolled up over the item tree. `tasks === null` means the read
// was capped (or refused): the rows' stored counts stand in, without the roll-up.
function countsOf(items: PbsRow[], tasks: TaskRow[] | null): Map<string, Count> {
  const direct = new Map<string, Count>()
  if (tasks) {
    for (const tk of tasks) {
      if (!tk.pbs_item_id) continue
      const c = direct.get(tk.pbs_item_id) ?? { done: 0, total: 0 }
      c.total += 1
      if (tk.closed) c.done += 1
      direct.set(tk.pbs_item_id, c)
    }
  }
  const byId = new Map(items.map((r) => [r.id, r]))
  const out = new Map<string, Count>()
  const walk = (id: string, seen: Set<string>): Count => {
    const hit = out.get(id)
    if (hit) return hit
    const row = byId.get(id)
    if (!row) return { done: 0, total: 0 }
    if (seen.has(id)) return { done: 0, total: 0 } // a cycle (the server refuses one)
    seen.add(id)
    const c: Count = tasks
      ? { done: direct.get(id)?.done ?? 0, total: direct.get(id)?.total ?? 0 }
      : { done: row.done_count, total: row.task_count }
    for (const kid of items) {
      if (kid.parent_id !== id) continue
      const kc = walk(kid.id, seen)
      c.done += kc.done
      c.total += kc.total
    }
    seen.delete(id)
    out.set(id, c)
    return c
  }
  for (const r of items) walk(r.id, new Set())
  return out
}

export function PbsRenderer({ config, projectId }: PbsRendererProps) {
  const t = useT()
  const ops = useRelationOps()
  const router = useRouter()
  const pathname = usePathname()
  const { entity, projectField, taskField } = config
  const [rows, setRows] = useState<PbsRow[] | null>(null)
  const [rowsCapped, setRowsCapped] = useState(false)
  const [tasks, setTasks] = useState<TaskRow[] | null>(null)
  const [tasksCapped, setTasksCapped] = useState(false)
  const [positions, setPositions] = useState<Record<string, Point>>({})
  const [error, setError] = useState<SerializedError | null>(null)
  const [reloads, setReloads] = useState(0)
  const [canEdit, setCanEdit] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const update = ops?.update
  // Undo/redo of moves, parent links, insertions, colors, edits and item create/delete.
  const history = useUndoHistory((e) => setError(serializeError(toApiError(e))))
  // An item re-created by an undo gets a new id: history steps name the id they knew, and
  // every write resolves it here (old id → the id that replaced it, chained).
  const alias = useRef(new Map<string, string>())
  const cur = (id: string) => {
    let x = id
    while (alias.current.has(x)) x = alias.current.get(x)!
    return x
  }

  const listPage = ops?.listPage
  useEffect(() => {
    if (!listPage) return
    let cancelled = false
    const load = async () => {
      const out: PbsRow[] = []
      for (let page = 1; ; page++) {
        const res = await listPage(entity, { filter: { [projectField]: projectId }, order: 'created_at', pageSize: PAGE_SIZE, page })
        out.push(...(res.records as unknown as PbsRow[]))
        if (res.records.length < PAGE_SIZE) return { items: out, capped: false }
        if (out.length >= DIAGRAM_RECORD_CAP) {
          // One full page past the cap: exactly DIAGRAM_RECORD_CAP matches isn't "more".
          const probe = await listPage(entity, { filter: { [projectField]: projectId }, order: 'created_at', pageSize: PAGE_SIZE, page: Math.ceil(DIAGRAM_RECORD_CAP / PAGE_SIZE) + 1 })
          return { items: out.slice(0, DIAGRAM_RECORD_CAP), capped: probe.records.length > 0 }
        }
      }
    }
    load().then(
      (r) => {
        if (cancelled) return
        setRowsCapped(r.capped)
        setRows(r.items)
        setPositions(savedPositions(r.items))
      },
      (e: unknown) => {
        if (cancelled) return
        setRowsCapped(false)
        setRows([])
        setError(serializeError(toApiError(e)))
      },
    )
    return () => {
      cancelled = true
    }
  }, [listPage, entity, projectField, projectId, reloads])
  // The tasks read: one paged pass of the project's tasks (wbs_number order), capped at
  // TASK_CAP — past it the rows' stored counts stand in (a refusal does too, silently).
  useEffect(() => {
    if (!listPage || !rows) return
    let cancelled = false
    const load = async () => {
      const out: TaskRow[] = []
      for (let page = 1; ; page++) {
        const res = await listPage(TASK_ENTITY, { filter: { [projectField]: projectId }, order: 'wbs_number', pageSize: PAGE_SIZE, page })
        out.push(...(res.records as unknown as TaskRow[]))
        if (res.records.length < PAGE_SIZE) return { tasks: out, capped: false }
        if (out.length >= TASK_CAP) {
          const probe = await listPage(TASK_ENTITY, { filter: { [projectField]: projectId }, order: 'wbs_number', pageSize: PAGE_SIZE, page: Math.ceil(TASK_CAP / PAGE_SIZE) + 1 })
          return { tasks: out.slice(0, TASK_CAP), capped: probe.records.length > 0 }
        }
      }
    }
    load().then(
      (r) => {
        if (cancelled) return
        setTasks(r.tasks)
        setTasksCapped(r.capped)
      },
      () => {
        if (cancelled) return
        setTasks([])
        setTasksCapped(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [listPage, projectField, projectId, rows])
  useEffect(() => {
    const guard = config.canEdit ? kanbanColumnsGuard(config.canEdit) : undefined
    if (!guard) return
    let cancelled = false
    guard(projectId, ops).then(
      (ok) => !cancelled && setCanEdit(ok),
      () => !cancelled && setCanEdit(false),
    )
    return () => {
      cancelled = true
    }
  }, [config.canEdit, projectId, ops])
  const editable = canEdit && !!update

  const counts = useMemo(() => (rows && tasks ? countsOf(rows, tasksCapped ? null : tasks) : new Map<string, Count>()), [rows, tasks, tasksCapped])

  if (rowsCapped) return <DiagramCapNotice />
  if (!rows || !tasks) return <DiagramLoading />
  const ids = new Set(rows.map((r) => r.id))
  const fail = (e: unknown) => setError(serializeError(toApiError(e)))
  const replace = (r: RelationRecord) => setRows((rs) => rs!.map((x) => (x.id === r.id ? { ...x, ...(r as unknown as PbsRow) } : x)))
  const patch = (id: string, body: Record<string, unknown>) => {
    setError(null)
    const b = typeof body.parent_id === 'string' ? { ...body, parent_id: cur(body.parent_id) } : body
    return update!(entity, cur(id), b).then(replace)
  }
  const removeBox = async (id: string) => {
    await ops!.remove(entity, cur(id))
    // The server detached its children and tasks: read the chart again.
    setReloads((n) => n + 1)
  }
  // Puts back a removed item (as `row` was) under the id `oldId` steps know it by, its
  // former children under it again.
  const recreate = async (row: PbsRow, oldId: string, children: string[]) => {
    const created = await ops!.create(entity, {
      [projectField]: projectId,
      name: row.name,
      description: row.description ?? '',
      color: row.color ?? null,
      parent_id: row.parent_id ? cur(row.parent_id) : null,
      x: row.x,
      y: row.y,
    })
    alias.current.set(cur(oldId), String(created.id))
    for (const c of children) await update!(entity, cur(c), { parent_id: String(created.id) })
    setReloads((n) => n + 1)
  }
  // A patch recorded for undo: `old` holds the same keys' current values.
  const change = (id: string, body: Record<string, unknown>) => {
    const row = rows.find((r) => r.id === id) as unknown as Record<string, unknown> | undefined
    const old = Object.fromEntries(Object.keys(body).map((k) => [k, row?.[k] ?? null]))
    setError(null)
    return history.perform(() => patch(id, body), () => patch(id, old))
  }
  // The task list pinned to this project and deliverable (the counts open it).
  const openTasks = (itemId: string) => {
    const q = new URLSearchParams()
    q.set(`filter[${projectField}]`, projectId)
    q.set(`filter[${taskField}]`, itemId)
    router.push(`${pathname}?${q.toString()}`)
  }

  const lines = treeGridEdges(rows, positions)
  const nodes: Node[] = rows.map((row) => ({
    id: row.id,
    type: 'pbs',
    targetPosition: lines.inGrid(row.id) ? Position.Left : Position.Top,
    position: { x: 0, y: 0 },
    width: PBS_BOX_SIZE.w,
    height: PBS_BOX_SIZE.h,
    data: {
      row,
      progress: counts.get(row.id) ?? { done: 0, total: 0 },
      editable,
      onColor: (color: string | null) => change(row.id, { color }),
      onDelete: () => {
        setError(null)
        const kept = { ...row, ...positions[row.id] }
        const children = rows.filter((r) => r.parent_id === row.id).map((r) => r.id)
        void history.perform(() => removeBox(row.id), () => recreate(kept, row.id, children))
      },
      onEdit: () => setDraft({ row }),
      onOpenTasks: () => openTasks(row.id),
    } satisfies PbsBoxData,
  }))
  const edges: Edge[] = rows
    .filter((r) => r.parent_id && ids.has(r.parent_id))
    .map((r) => ({ id: `${r.parent_id}->${r.id}`, source: r.parent_id!, target: r.id, deletable: editable, ...lines.edge(r.id) }))

  const autoLayout = () => {
    const tree = buildWbs(rows.map((r) => ({ id: r.id, parentId: r.parent_id && ids.has(r.parent_id) ? r.parent_id : null })), new Set())
    return layoutTreeGrid(tree.nodes, tree.roots, tree.visible, PBS_BOX_SIZE)
  }

  const onConnect = ({ source, target }: Connection) => {
    if (source !== target) void change(target, { parent_id: source })
  }
  const onEdgesDelete = (deleted: Edge[]) => {
    for (const e of deleted) void change(e.target, { parent_id: null })
  }
  // An item with no parent and no child dropped across a line P → C goes in between.
  const canInsert = (id: string) => {
    const row = rows.find((r) => r.id === id)
    return !!row && !(row.parent_id && ids.has(row.parent_id)) && !rows.some((r) => r.parent_id === id)
  }
  const onInsert = (id: string, { source: p, target: c }: Edge) => {
    setError(null)
    void history.perform(
      async () => {
        await patch(id, { parent_id: p })
        await patch(c, { parent_id: id })
      },
      async () => {
        await patch(c, { parent_id: p })
        await patch(id, { parent_id: null })
      },
    )
  }
  // Positions move first (the controlled canvas draws only these); refused ones go back.
  const onMove = async (asked: Record<string, Point>) => {
    // Undo/redo replays a move by the ids it knew.
    const moved = Object.fromEntries(Object.entries(asked).map(([id, p]) => [cur(id), p]))
    const before = positions
    setError(null)
    setPositions((p) => ({ ...p, ...moved }))
    const done = await Promise.allSettled(Object.entries(moved).map(([id, p]) => update!(entity, id, { x: p.x, y: p.y })))
    const failed = Object.keys(moved).filter((_, i) => done[i].status === 'rejected')
    if (!failed.length) return true
    setPositions((p) => {
      const next = { ...p }
      for (const id of failed) {
        // A later drop of the same box has moved it since: that one wins.
        if (next[id]?.x !== moved[id].x || next[id]?.y !== moved[id].y) continue
        if (before[id]) next[id] = before[id]
        else delete next[id]
      }
      return next
    })
    fail((done.find((d) => d.status === 'rejected') as PromiseRejectedResult).reason)
    return false
  }

  const submit = async ({ name, description, parentId }: { name: string; description: string; parentId: string | null }) => {
    const d = draft!
    const body: Record<string, unknown> = { name, description, parent_id: parentId ? cur(parentId) : null }
    if (d.row) {
      const old = { name: d.row.name, description: d.row.description, parent_id: d.row.parent_id }
      await patch(d.row.id, body)
      history.push({ undo: () => patch(d.row!.id, old), redo: () => patch(d.row!.id, body) })
      return
    }
    const spot = d.spot ?? { x: 0, y: 0 }
    const created = await ops!.create(entity, {
      [projectField]: projectId,
      name,
      description,
      color: null,
      parent_id: parentId ? cur(parentId) : null,
      ...spot,
    })
    const row = created as unknown as PbsRow
    setRows((rs) => [...rs!, row])
    setPositions((p) => ({ ...p, [row.id]: spot }))
    history.push({ undo: () => removeBox(row.id), redo: () => recreate({ ...row, ...spot }, row.id, []) })
  }

  const addButtons = (centerSpot: (size: { w: number; h: number }) => Point) => (
    <ToolButton icon="box-open" label={t('Add item')} onClick={() => setDraft({ spot: centerSpot(PBS_BOX_SIZE) })} />
  )

  return (
    <>
      <ErrorAlert error={error} />
      {tasksCapped ? <Box component="p" sx={{ m: 0, px: 1 }}>{t('First 1000 shown')}</Box> : null}
      <DiagramCanvas
        entity={entity}
        mode="pbs"
        title={t('PBS')}
        nodes={nodes}
        edges={edges}
        autoLayout={autoLayout}
        positions={positions}
        onMove={editable ? onMove : undefined}
        onConnect={editable ? onConnect : undefined}
        onEdgesDelete={editable ? onEdgesDelete : undefined}
        onInsert={editable ? onInsert : undefined}
        canInsert={canInsert}
        history={editable ? history : undefined}
        readOnly={!editable}
        legend={[]}
        toolbarExtra={editable ? addButtons : undefined}
      />
      {draft && ops ? <PbsItemDialog draft={draft} rows={rows} onSubmit={submit} onClose={() => setDraft(null)} /> : null}
    </>
  )
}

/** The add/edit item dialog: name, description and a Parent select (how a phone
 * re-parents: there is no drawing there, the select is the only way). */
function PbsItemDialog({ draft, rows, onSubmit, onClose }: {
  draft: Draft
  rows: PbsRow[]
  /** Rejects with the refusal, shown in the dialog. */
  onSubmit: (v: { name: string; description: string; parentId: string | null }) => Promise<void>
  onClose: () => void
}) {
  const t = useT()
  const row = draft.row
  const [name, setName] = useState(row?.name ?? '')
  const [description, setDescription] = useState(row?.description ?? '')
  const [parentId, setParentId] = useState(row?.parent_id ?? '')
  const [error, setError] = useState<SerializedError | null>(null)
  const [busy, setBusy] = useState(false)
  const fail = (e: unknown) => setError(serializeError(toApiError(e)))
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSubmit({ name: name.trim(), description, parentId: parentId || null })
      onClose()
    } catch (e: unknown) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  // The item's own box and its descendants can't be its parent (the server refuses a
  // cycle with a 422): the rest of the chart is offered as-is.
  const options = rows.filter((r) => r.id !== row?.id)
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <BannerScope>
        <Box>
          <DialogTitle>{row ? t('Edit item') : t('Add item')}</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              <BannerSlot sx={{ mb: 0 }} />
              <ErrorAlert error={error} />
              <TextField label={t('Name')} value={name} onChange={(e) => setName(e.target.value)} slotProps={{ htmlInput: { maxLength: 200 } }} />
              <TextField label={t('Description')} value={description} onChange={(e) => setDescription(e.target.value)} multiline minRows={2} slotProps={{ htmlInput: { maxLength: 2000 } }} />
              <FormControl size="small">
                <Select aria-label={t('Parent')} value={parentId} onChange={(e) => setParentId(e.target.value)}>
                  <MenuItem value="">{t('No parent')}</MenuItem>
                  {options.map((r) => (
                    <MenuItem key={r.id} value={r.id}>{r.name}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>{t('Cancel')}</Button>
            <Button variant="contained" onClick={() => void save()} disabled={busy}>
              {row ? t('Save') : t('Create')}
            </Button>
          </DialogActions>
        </Box>
      </BannerScope>
    </Dialog>
  )
}
