'use client'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import IconButton from '@mui/material/IconButton'
import Popover from '@mui/material/Popover'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { ThemeProvider, useTheme } from '@mui/material/styles'
import {
  Background,
  Controls,
  getNodesBounds,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance,
} from '@xyflow/react'
import { serializeError, toApiError, type SerializedError } from '../../api/errors'
import type { EntityListOptions } from '../../api/list-options'
import { useT } from '../../i18n/translate'
import { ErrorAlert } from '../error-alert'
import { byPrefixAndName, FontAwesomeIcon } from '../icons'
import { RelationOpsProvider, useRelationOps, type DiagramNote, type RelationOps, type RelationRecord, type ViewLayout } from '../relation-ops'
import type { HasId } from '../stores'
import { freeSpot, separateBoxes, type Point, type Rect } from './collide'
import { compactTheme, ForceDetail, LabelBox, NOTE_BOX_SIZE, NOTE_LIMIT, NOTE_LINK_LIMIT, NoteBox, TASK_BOX_SIZE, TaskBox, type NoteBoxData } from './task-box'

// The canvas WBS and PERT share: React Flow plus the user's own saved arrangement
// (RelationOps.getViewLayout/saveViewLayout, optional and fail-open). Saved boxes keep
// their spot, the others take autoLayout()'s, moved clear of the saved ones; a dropped
// box lands on the nearest free spot and the whole arrangement is saved 500 ms after
// the last drop. Nodes default to the `task` type (TaskBox). Shift+click adds a box to the
// selection, Shift+drag on the pane draws a selection rectangle (React Flow's own keys), and
// dragging a selected box moves the whole selection. With `notes`, the user also adds
// free-text note boxes, saved in the same layout and linked to boxes by dashed lines.

export const DIAGRAM_RECORD_CAP = 2000
/** The server's limit on saved positions (and folded ids) per layout. */
export const LAYOUT_POSITION_LIMIT = 5000
const PAGE_SIZE = 200
const SAVE_DELAY_MS = 500

/** Every record matching `serverOptions` (paged until a short page, never trusting
 * `total`), up to DIAGRAM_RECORD_CAP; `capped` when a probe finds more. Without
 * `serverOptions` or a bound `listPage`, the seeded `initialData`. */
export function useDiagramRecords<T extends HasId>(
  entity: string,
  serverOptions: EntityListOptions | undefined,
  initialData: T[],
): { records: T[]; capped: boolean; loading: boolean; error: string | null; reload: () => void } {
  const listPage = useRelationOps()?.listPage
  const key = serverOptions && listPage ? JSON.stringify(serverOptions) : null
  const [state, setState] = useState<{ records: T[]; capped: boolean } | null>(null)
  const [loading, setLoading] = useState(key != null)
  const [error, setError] = useState<string | null>(null)
  const [reloads, setReloads] = useState(0)
  useEffect(() => {
    if (key == null || !listPage) return
    const opts = JSON.parse(key) as EntityListOptions
    const scoped: EntityListOptions = { ...opts, order: opts.order ?? 'id', pageSize: PAGE_SIZE }
    let cancelled = false
    const load = async () => {
      const rows: T[] = []
      for (let page = 1; ; page++) {
        const res = await listPage(entity, { ...scoped, page })
        rows.push(...(res.records as unknown as T[]))
        if (res.records.length < PAGE_SIZE) return { records: rows, capped: false }
        if (rows.length >= DIAGRAM_RECORD_CAP) {
          // One probe row past the cap: exactly DIAGRAM_RECORD_CAP matches isn't "more".
          const probe = await listPage(entity, { ...scoped, page: DIAGRAM_RECORD_CAP + 1, pageSize: 1 })
          return { records: rows, capped: probe.records.length > 0 }
        }
      }
    }
    setLoading(true)
    load()
      .then((r) => {
        if (cancelled) return
        setError(null)
        setState(r)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(toApiError(e).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [key, listPage, entity, reloads])
  return {
    records: key == null ? initialData : (state?.records ?? initialData),
    capped: key != null && !!state?.capped,
    loading: key != null && loading,
    error: key == null ? null : error,
    reload: () => setReloads((n) => n + 1),
  }
}

/** What a renderer shows instead of the canvas when useDiagramRecords is capped. */
export function DiagramCapNotice() {
  const t = useT()
  return (
    <Typography color="text.secondary" sx={{ p: 2 }}>
      {t('More than {n} records match — narrow the filters to draw the diagram').replace('{n}', String(DIAGRAM_RECORD_CAP))}
    </Typography>
  )
}

/** What a renderer shows while useDiagramRecords is still reading. */
export function DiagramLoading() {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
      <CircularProgress size={24} />
    </Box>
  )
}

/** The positions to save: every known one, the drawn ones kept first when over `limit`
 * (a folded branch or a narrower filter keeps its boxes' spots for later). */
export function trimPositions(positions: Record<string, Point>, drawn: Set<string>, limit = LAYOUT_POSITION_LIMIT): Record<string, Point> {
  const ids = Object.keys(positions)
  if (ids.length <= limit) return positions
  const kept = [...ids.filter((id) => drawn.has(id)), ...ids.filter((id) => !drawn.has(id))].slice(0, limit)
  return Object.fromEntries(kept.map((id) => [id, positions[id]]))
}

// The selection after React Flow's select changes.
function toggled(prev: Set<string>, picks: { id: string; selected: boolean }[]): Set<string> {
  const next = new Set(prev)
  for (const c of picks) {
    if (c.selected) next.add(c.id)
    else next.delete(c.id)
  }
  return next
}

/** How to use the canvas: the tips that apply to what this canvas allows. */
function DiagramHelp({ mode, links, drop, notes }: { mode: 'wbs' | 'pert' | 'obs'; links: boolean; drop: boolean; notes: boolean }) {
  const t = useT()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const tips = [
    t('Scroll to zoom, drag the background to move around.'),
    t('Drag a box to move it: your arrangement is saved for you only.'),
    t('Shift+click or Shift+drag on the background selects several boxes; drag one to move them all.'),
    t('Double-click a box to open its record. Zoomed out, boxes show only their title.'),
    links && (mode === 'pert'
      ? t('Drag from the dot on the right of a box to another box to add a dependency.')
      : t('Drag from the dot under a box to another box to make it its parent.')),
    links && t('Click a link to select it, then press Delete to remove it.'),
    drop && t('Drop a box onto another to move it under that one.'),
    notes && t('Add note adds a text box only you see; drag from its dot to a box to link them.'),
    t('Re-arrange places every box again; Fit view shows the whole diagram.'),
  ].filter((x): x is string => !!x)
  return (
    <>
      <IconButton size="small" aria-label={t('How to use this diagram')} onClick={(e) => setAnchor(e.currentTarget)}>
        <FontAwesomeIcon icon={byPrefixAndName.fas['circle-info']} />
      </IconButton>
      <Popover open={!!anchor} anchorEl={anchor} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}>
        <Box component="ul" sx={{ m: 0, p: 2, pl: 4, maxWidth: 420 }}>
          {tips.map((tip) => (
            <Typography key={tip} component="li" variant="body2" sx={{ mb: 0.5 }}>{tip}</Typography>
          ))}
        </Box>
      </Popover>
    </>
  )
}

function BoxOps({ ops, children }: { ops: RelationOps | null; children: ReactNode }) {
  return ops ? <RelationOpsProvider ops={ops}>{children}</RelationOpsProvider> : <>{children}</>
}

/** RelationOps whose `get` is cached per entity:id (in-flight promises shared, failures
 * forgotten): every box showing the same many2one resolves its label with one read. */
function useCachedGet(ops: RelationOps | null): RelationOps | null {
  return useMemo(() => {
    if (!ops) return null
    const cache = new Map<string, Promise<RelationRecord>>()
    const get = (entity: string, id: string) => {
      const key = `${entity}:${id}`
      let p = cache.get(key)
      if (!p) {
        p = ops.get(entity, id)
        p.catch(() => cache.delete(key))
        cache.set(key, p)
      }
      return p
    }
    return { ...ops, get }
  }, [ops])
}

export interface DiagramCanvasProps {
  entity: string
  mode: 'wbs' | 'pert' | 'obs'
  title: string
  /** Positions are ignored: the canvas places them. */
  nodes: Node[]
  edges: Edge[]
  /** Called for unsaved boxes and by Re-arrange. */
  autoLayout: () => Record<string, Point>
  folded?: string[]
  onFoldedChange?: (folded: string[]) => void
  onConnect?: (c: Connection) => void
  onEdgesDelete?: (e: Edge[]) => void
  /** An edge end dragged onto another box (only `reconnectable` edges). */
  onReconnect?: (old: Edge, c: Connection) => void
  /** WBS re-parent: the box under the dropped one, and every box's top-left (the dropped
   * one where it was let go). `false` (now or once resolved) puts the box back where it
   * was before the drag. */
  onNodeDrop?: (id: string, overId: string | null, at: Record<string, Point>) => boolean | void | Promise<boolean | void>
  legend: { color: string; label: string }[]
  toolbarExtra?: ReactNode
  /** Offer "Add note": the user's own text boxes, linkable to any box. */
  notes?: boolean
  /** Controlled: these are the fixed positions (no layout read or save); the caller stores
   * drops reported to `onMove`. */
  positions?: Record<string, Point>
  /** Boxes dropped (one or a selection) with their free spots. `false` (now or once resolved)
   * refuses: they go back where they were. */
  onMove?: (moved: Record<string, Point>) => boolean | void | Promise<boolean | void>
}

const nodeTypes: NodeTypes = { task: TaskBox, label: LabelBox, note: NoteBox }
const NOTE_EDGE = 'note-link:'
// No notes is no key: a layout without notes saves as it always did.
const savedNotes = (notes: DiagramNote[]) => (notes.length ? notes : undefined)
// Measured size, else the node's declared one (a WBS group root is shorter), else a task box.
const size = (n?: Node) => ({
  w: n?.measured?.width ?? n?.width ?? TASK_BOX_SIZE.w,
  h: n?.measured?.height ?? n?.height ?? TASK_BOX_SIZE.h,
})

export function DiagramCanvas(props: DiagramCanvasProps) {
  // Another entity or mode is another layout: start over (unmounting flushes a pending save).
  return <Canvas key={`${props.entity}:${props.mode}`} {...props} />
}

function Canvas(props: DiagramCanvasProps) {
  const { entity, mode, title, nodes, edges, autoLayout, folded = [], onFoldedChange, onNodeDrop, legend } = props
  const t = useT()
  const outer = useTheme()
  const ops = useRelationOps()
  const boxOps = useCachedGet(ops)
  const compact = useMemo(() => compactTheme(outer), [outer])
  // Controlled positions never touch the per-user layout.
  const layoutMode = mode === 'obs' ? undefined : mode
  const getViewLayout = props.positions || !layoutMode ? undefined : ops?.getViewLayout
  const saveViewLayout = props.positions || !layoutMode ? undefined : ops?.saveViewLayout
  const [loaded, setLoaded] = useState(!getViewLayout)
  // Fixed positions: loaded, dropped or re-arranged. Ids not drawn now (folded, filtered
  // out) keep theirs and are saved with the rest.
  const [ownPositions, setPositions] = useState<Record<string, Point>>({})
  const positions = props.positions ?? ownPositions
  // Kept (and saved back) even where they aren't drawn: they belong to the saved layout.
  const [notes, setNotes] = useState<DiagramNote[]>([])
  const [live, setLive] = useState<Record<string, Point>>({})
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({})
  // Edges are controlled: React Flow's Delete key only targets edges passed in as selected.
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set())
  // Nodes are controlled too: a selection only shows (and drags together) once passed back.
  const [selectedNodes, setSelectedNodes] = useState<Set<string>>(new Set())
  const [saveError, setSaveError] = useState<SerializedError | null>(null)
  const [exportError, setExportError] = useState<SerializedError | null>(null)
  const [exporting, setExporting] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const instance = useRef<ReactFlowInstance | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Folds: the saved ones (kept as-is when the parent doesn't manage folds), the prop's
  // last value, and the loaded value until the parent has echoed it back once.
  const loadedFolded = useRef<string[]>([])
  const prevFolded = useRef(JSON.stringify(folded))
  const echo = useRef<string | null>(null)

  // Read through refs: the props are new functions on every parent render.
  const autoRef = useRef(autoLayout)
  const foldedChangeRef = useRef(onFoldedChange)
  useEffect(() => {
    autoRef.current = autoLayout
    foldedChangeRef.current = onFoldedChange
  })

  useEffect(() => {
    if (!getViewLayout || !layoutMode) return
    let cancelled = false
    getViewLayout(entity, layoutMode)
      .then((layout) => {
        if (cancelled) return
        setPositions(layout.positions)
        setNotes(layout.notes ?? [])
        loadedFolded.current = layout.folded
        echo.current = JSON.stringify(layout.folded)
        foldedChangeRef.current?.(layout.folded)
      })
      .catch(() => {}) // fail-open: an unreadable layout is the empty one
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [entity, mode, getViewLayout])

  // Note callbacks run on user events, after the helpers below are defined.
  const noteNodes: Node[] = props.notes
    ? notes.map((n) => ({
        id: n.id,
        type: 'note',
        position: { x: 0, y: 0 },
        width: NOTE_BOX_SIZE.w,
        height: NOTE_BOX_SIZE.h,
        data: {
          text: n.text,
          onText: (text: string) => changeNote(n.id, (x) => ({ ...x, text })),
          onDelete: () => deleteNote(n.id),
        } satisfies NoteBoxData,
      }))
    : []
  const noteIds = new Set(noteNodes.map((n) => n.id))
  const all = [...nodes, ...noteNodes]
  const ids = all.map((n) => n.id)
  const idsKey = ids.join('\n')
  const placed = useMemo(() => {
    const auto = autoRef.current()
    return separateBoxes(
      all.map((n) => {
        const p = positions[n.id] ?? auto[n.id] ?? { x: 0, y: 0 }
        const { w, h } = size({ ...n, measured: undefined })
        return { id: n.id, ...p, w, h, fixed: n.id in positions }
      }),
    )
  }, [idsKey, positions])

  const savedFolded = onFoldedChange ? folded : loadedFolded.current
  const drawn = useMemo(() => new Set(ids), [idsKey])
  const toSave = (all: Record<string, Point>) => trimPositions(all, drawn)
  const latest = useRef({ positions, placed, drawn, folded: savedFolded, notes })
  useEffect(() => {
    latest.current = { positions, placed, drawn, folded: savedFolded, notes }
  })

  const save = (layout: ViewLayout) => {
    if (!saveViewLayout || !layoutMode) return
    saveViewLayout(entity, layoutMode, layout).then(
      () => setSaveError(null),
      (e: unknown) => setSaveError(serializeError(toApiError(e))),
    )
  }
  const flush = () => {
    timer.current = null
    const l = latest.current
    save({ positions: trimPositions({ ...l.positions, ...l.placed }, l.drawn), folded: l.folded, notes: savedNotes(l.notes) })
  }
  const scheduleSave = () => {
    if (!saveViewLayout) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_DELAY_MS)
  }

  const changeNote = (id: string, f: (n: DiagramNote) => DiagramNote) => {
    setNotes((ns) => ns.map((n) => (n.id === id ? f(n) : n)))
    scheduleSave()
  }
  const deleteNote = (id: string) => {
    setNotes((ns) => ns.filter((n) => n.id !== id))
    setPositions((p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== id)))
    scheduleSave()
  }
  const addNote = () => {
    const id = `note-${crypto.randomUUID()}`
    // The middle of what the user is looking at, on the nearest free spot.
    const box = container.current?.getBoundingClientRect()
    const mid = box && instance.current
      ? instance.current.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 })
      : { x: 0, y: 0 }
    const { w, h } = NOTE_BOX_SIZE
    const spot = freeSpot({ x: mid.x - w / 2, y: mid.y - h / 2, w, h }, ids.map((i) => ({ ...placed[i], ...sized(i) })))
    setNotes((ns) => [...ns, { id, text: '', links: [] }])
    setPositions((p) => ({ ...p, ...placed, [id]: spot }))
    scheduleSave()
  }

  const flushRef = useRef(flush)
  useEffect(() => {
    flushRef.current = flush
  })
  // Leaving with a save pending: send it now rather than drop the user's last move.
  useEffect(() => () => {
    if (!timer.current) return
    clearTimeout(timer.current)
    flushRef.current()
  }, [])

  // A fold change by the user is part of the layout; the parent echoing the loaded folds isn't.
  const foldedNow = JSON.stringify(folded)
  useEffect(() => {
    if (foldedNow === prevFolded.current) return
    prevFolded.current = foldedNow
    const isEcho = foldedNow === echo.current
    echo.current = null
    if (loaded && !isEcho) scheduleSave()
  }, [foldedNow, loaded])

  const byId = new Map(all.map((n) => [n.id, n]))
  const sized = (id: string) => (sizes[id] ? { w: sizes[id].width, h: sizes[id].height } : size(byId.get(id)))
  const vertical = mode === 'wbs'
  // A drag frame re-renders only the canvas: every other box keeps its node object, so
  // React Flow skips it (2000 boxes would otherwise all re-render per frame).
  const built = useRef(new Map<string, { src: Node; position: Point; size?: { width: number; height: number }; selected: boolean; node: Node }>())
  const rfNodes: Node[] = all.map((n) => {
    const position = live[n.id] ?? placed[n.id]
    const selected = selectedNodes.has(n.id)
    const prev = built.current.get(n.id)
    if (prev && prev.src === n && prev.position === position && prev.size === sizes[n.id] && prev.selected === selected) return prev.node
    const node: Node = {
      ...n,
      type: n.type ?? 'task',
      position,
      deletable: false,
      selected,
      sourcePosition: vertical ? Position.Bottom : Position.Right,
      targetPosition: vertical ? Position.Top : Position.Left,
      ...(sizes[n.id] ? { measured: sizes[n.id] } : {}),
    }
    built.current.set(n.id, { src: n, position, size: sizes[n.id], selected, node })
    return node
  })

  const onNodesChange = (changes: NodeChange[]) => {
    const moves = changes.flatMap((c) => (c.type === 'position' && c.position ? [[c.id, c.position] as const] : []))
    if (moves.length) setLive((l) => ({ ...l, ...Object.fromEntries(moves) }))
    const measured = changes.flatMap((c) => (c.type === 'dimensions' && c.dimensions ? [[c.id, c.dimensions] as const] : []))
    if (measured.length) setSizes((m) => ({ ...m, ...Object.fromEntries(measured) }))
    const picks = changes.filter((c) => c.type === 'select')
    if (picks.length) setSelectedNodes((prev) => toggled(prev, picks))
  }

  // Controlled positions come back from the caller, so a refused move needs no undo here.
  const reportMove = (onMove: NonNullable<DiagramCanvasProps['onMove']>, moved: Record<string, Point>, undo: (ok: boolean | void) => void) => {
    const res = onMove(moved)
    if (res instanceof Promise) void res.then(undo, () => undo(false))
    else undo(res)
  }

  const onNodeDragStop = (_: unknown, node: Node, dragged: Node[] = [node]) => {
    // A selection moved together: only the layout changes (no re-parent), each box on the
    // free spot nearest where it was let go, clear of the others and of the boxes placed before it.
    if (dragged.length > 1) {
      const moved = new Set(dragged.map((n) => n.id))
      const taken: Rect[] = ids.filter((id) => !moved.has(id)).map((id) => ({ ...placed[id], ...sized(id) }))
      const next = { ...positions, ...placed }
      for (const n of dragged) {
        const spot = freeSpot({ ...n.position, ...sized(n.id) }, taken)
        next[n.id] = spot
        taken.push({ ...spot, ...sized(n.id) })
      }
      setPositions(next)
      setLive({})
      scheduleSave()
      if (props.onMove) reportMove(props.onMove, Object.fromEntries(dragged.map((n) => [n.id, next[n.id]])), () => {})
      return
    }
    const rect: Rect = { ...node.position, ...sized(node.id) }
    const others = ids.filter((id) => id !== node.id).map((id) => ({ id, ...placed[id], ...sized(id) }))
    const before = placed[node.id]
    const putBack = (ok: boolean | void) => {
      if (ok !== false || !before) return
      setPositions((p) => ({ ...p, [node.id]: before }))
      scheduleSave()
    }
    const spot = freeSpot(rect, others)
    setPositions({ ...positions, ...placed, [node.id]: spot })
    if (props.onMove) reportMove(props.onMove, { [node.id]: spot }, putBack)
    if (onNodeDrop && !noteIds.has(node.id)) {
      const cx = rect.x + rect.w / 2
      const cy = rect.y + rect.h / 2
      const over = others.find((o) => cx >= o.x && cx <= o.x + o.w && cy >= o.y && cy <= o.y + o.h)
      const res = onNodeDrop(node.id, over?.id ?? null, { ...placed, [node.id]: rect })
      if (res instanceof Promise) void res.then(putBack, () => putBack(false))
      else putBack(res)
    }
    setLive({})
    scheduleSave()
  }

  const rearrange = () => {
    const auto = autoRef.current()
    // Only the drawn boxes are re-arranged; hidden ones and notes keep their spot.
    const next = { ...positions, ...placed, ...Object.fromEntries(nodes.map((n) => [n.id, auto[n.id] ?? { x: 0, y: 0 }])) }
    setPositions(next)
    setLive({})
    if (props.onMove) {
      reportMove(props.onMove, Object.fromEntries(nodes.map((n) => [n.id, next[n.id]])), () => {})
      return
    }
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    save({ positions: toSave(next), folded: savedFolded, notes: savedNotes(notes) })
  }

  const onEdgesChange = (changes: EdgeChange[]) => {
    const picks = changes.filter((c) => c.type === 'select')
    if (picks.length) setSelectedEdges((prev) => toggled(prev, picks))
  }
  const noteEdges: Edge[] = noteNodes.flatMap((n) =>
    notes.find((x) => x.id === n.id)!.links
      .filter((id) => drawn.has(id) && !noteIds.has(id))
      .map((id) => ({ id: `${NOTE_EDGE}${n.id}>${id}`, source: n.id, target: id, data: { note: n.id, box: id }, style: { strokeDasharray: '4 4' } })),
  )
  const rfEdges = [...edges, ...noteEdges].map((e) => (selectedEdges.has(e.id) ? { ...e, selected: true } : e))

  // A link with a note on one end belongs to the note; box-to-box ones go to the renderer.
  const onConnect = (c: Connection) => {
    const fromNote = noteIds.has(c.source)
    if (!fromNote && !noteIds.has(c.target)) return props.onConnect?.(c)
    if (fromNote === noteIds.has(c.target)) return
    const [note, box] = fromNote ? [c.source, c.target] : [c.target, c.source]
    changeNote(note, (n) => (n.links.includes(box) || n.links.length >= NOTE_LINK_LIMIT ? n : { ...n, links: [...n.links, box] }))
  }
  const onEdgesDelete = (deleted: Edge[]) => {
    const isNote = (e: Edge) => e.id.startsWith(NOTE_EDGE)
    for (const e of deleted.filter(isNote)) {
      const { note, box } = e.data as { note: string; box: string }
      changeNote(note, (n) => ({ ...n, links: n.links.filter((id) => id !== box) }))
    }
    const rest = deleted.filter((e) => !isNote(e))
    if (rest.length) props.onEdgesDelete?.(rest)
  }

  const exportAs = async (kind: 'png' | 'pdf') => {
    const viewport = container.current?.querySelector<HTMLElement>('.react-flow__viewport')
    if (!viewport) return
    const bounds = getNodesBounds(rfNodes)
    setExportError(null)
    // Full boxes in the image even when zoomed out: drawn before the capture starts.
    flushSync(() => setExporting(true))
    try {
      // html-to-image and jspdf load on the first export, not with the diagram.
      const { exportPdf, exportPng } = await import('./export')
      // The diagram's own background: a dark theme's light text stays readable in the image.
      const background = outer.palette.background.paper
      if (kind === 'png') await exportPng(viewport, bounds, title, background)
      else await exportPdf(viewport, bounds, { title, date: new Date(), legend, background }, title)
    } catch (e: unknown) {
      setExportError(serializeError(toApiError(e)))
    } finally {
      setExporting(false)
    }
  }

  return (
    <Box>
      <ErrorAlert error={saveError ?? exportError} />
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', mb: 1 }}>
        <DiagramHelp mode={mode} links={!!props.onConnect} drop={!!onNodeDrop} notes={!!props.notes} />
        <Button size="small" onClick={rearrange}>{t('Re-arrange')}</Button>
        <Button size="small" onClick={() => void exportAs('png')}>{t('Export PNG')}</Button>
        <Button size="small" onClick={() => void exportAs('pdf')}>{t('Export PDF')}</Button>
        <Button size="small" onClick={() => instance.current?.fitView()}>{t('Fit view')}</Button>
        {props.notes ? <Button size="small" onClick={addNote} disabled={notes.length >= NOTE_LIMIT}>{t('Add note')}</Button> : null}
        {legend.map((l) => (
          <Stack key={l.label} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <Box aria-hidden sx={{ width: 12, height: 12, borderRadius: 0.5, bgcolor: l.color }} />
            <Typography variant="caption" color="text.secondary">{l.label}</Typography>
          </Stack>
        ))}
        {props.toolbarExtra}
      </Stack>
      <Box ref={container} sx={{ height: '70vh', border: 1, borderColor: 'divider', borderRadius: 1 }}>
        {loaded ? (
          <BoxOps ops={boxOps}>
          <ThemeProvider theme={compact}>
          <ForceDetail.Provider value={exporting}>
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            onConnect={props.onConnect || props.notes ? onConnect : undefined}
            onEdgesDelete={props.onEdgesDelete || props.notes ? onEdgesDelete : undefined}
            nodesConnectable={!!props.onConnect || !!props.notes}
            selectionKeyCode="Shift"
            multiSelectionKeyCode="Shift"
            onReconnect={props.onReconnect}
            edgesReconnectable={false}
            onInit={(i) => {
              instance.current = i
            }}
            minZoom={0.1}
            fitView
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
          </ForceDetail.Provider>
          </ThemeProvider>
          </BoxOps>
        ) : null}
      </Box>
    </Box>
  )
}
