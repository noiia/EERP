'use client'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
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
import { useRelationOps } from '../relation-ops'
import type { HasId } from '../stores'
import { freeSpot, separateBoxes, type Point, type Rect } from './collide'
import { exportPdf, exportPng } from './export'
import { TASK_BOX_SIZE, TaskBox } from './task-box'

// The canvas WBS and PERT share: React Flow plus the user's own saved arrangement
// (RelationOps.getViewLayout/saveViewLayout, optional and fail-open). Saved boxes keep
// their spot, the others take autoLayout()'s, moved clear of the saved ones; a dropped
// box lands on the nearest free spot and the whole arrangement is saved 500 ms after
// the last drop. Nodes default to the `task` type (TaskBox).

export const DIAGRAM_RECORD_CAP = 2000
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
      {t('More than')} {DIAGRAM_RECORD_CAP} {t('records match — narrow the filters to draw the diagram')}
    </Typography>
  )
}

export interface DiagramCanvasProps {
  entity: string
  mode: 'wbs' | 'pert'
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
  /** WBS re-parent: the box under the dropped one. */
  onNodeDrop?: (id: string, overId: string | null) => void
  legend: { color: string; label: string }[]
  toolbarExtra?: ReactNode
}

const nodeTypes: NodeTypes = { task: TaskBox }
const size = (n?: Node) => ({ w: n?.measured?.width ?? TASK_BOX_SIZE.w, h: n?.measured?.height ?? TASK_BOX_SIZE.h })

export function DiagramCanvas(props: DiagramCanvasProps) {
  // Another entity or mode is another layout: start over (unmounting flushes a pending save).
  return <Canvas key={`${props.entity}:${props.mode}`} {...props} />
}

function Canvas(props: DiagramCanvasProps) {
  const { entity, mode, title, nodes, edges, autoLayout, folded = [], onFoldedChange, onNodeDrop, legend } = props
  const t = useT()
  const ops = useRelationOps()
  const getViewLayout = ops?.getViewLayout
  const saveViewLayout = ops?.saveViewLayout
  const [loaded, setLoaded] = useState(!getViewLayout)
  // Fixed positions: loaded, dropped or re-arranged. Ids no longer drawn just stay unused.
  const [positions, setPositions] = useState<Record<string, Point>>({})
  const [live, setLive] = useState<Record<string, Point>>({})
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({})
  // Edges are controlled: React Flow's Delete key only targets edges passed in as selected.
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set())
  const [saveError, setSaveError] = useState<SerializedError | null>(null)
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
    if (!getViewLayout) return
    let cancelled = false
    getViewLayout(entity, mode)
      .then((layout) => {
        if (cancelled) return
        setPositions(layout.positions)
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

  const ids = nodes.map((n) => n.id)
  const idsKey = ids.join('\n')
  const placed = useMemo(() => {
    const auto = autoRef.current()
    return separateBoxes(
      ids.map((id) => {
        const p = positions[id] ?? auto[id] ?? { x: 0, y: 0 }
        return { id, ...p, w: TASK_BOX_SIZE.w, h: TASK_BOX_SIZE.h, fixed: id in positions }
      }),
    )
  }, [idsKey, positions])

  const savedFolded = onFoldedChange ? folded : loadedFolded.current
  const latest = useRef({ placed, folded: savedFolded })
  useEffect(() => {
    latest.current = { placed, folded: savedFolded }
  })

  const save = (layout: { positions: Record<string, Point>; folded: string[] }) => {
    if (!saveViewLayout) return
    saveViewLayout(entity, mode, layout).then(
      () => setSaveError(null),
      (e: unknown) => setSaveError(serializeError(toApiError(e))),
    )
  }
  const flush = () => {
    timer.current = null
    save({ positions: latest.current.placed, folded: latest.current.folded })
  }
  const scheduleSave = () => {
    if (!saveViewLayout) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_DELAY_MS)
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

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const sized = (id: string) => (sizes[id] ? { w: sizes[id].width, h: sizes[id].height } : size(byId.get(id)))
  const vertical = mode === 'wbs'
  const rfNodes: Node[] = nodes.map((n) => ({
    ...n,
    type: n.type ?? 'task',
    position: live[n.id] ?? placed[n.id],
    deletable: false,
    sourcePosition: vertical ? Position.Bottom : Position.Right,
    targetPosition: vertical ? Position.Top : Position.Left,
    ...(sizes[n.id] ? { measured: sizes[n.id] } : {}),
  }))

  const onNodesChange = (changes: NodeChange[]) => {
    const moves = changes.flatMap((c) => (c.type === 'position' && c.position ? [[c.id, c.position] as const] : []))
    if (moves.length) setLive((l) => ({ ...l, ...Object.fromEntries(moves) }))
    const measured = changes.flatMap((c) => (c.type === 'dimensions' && c.dimensions ? [[c.id, c.dimensions] as const] : []))
    if (measured.length) setSizes((m) => ({ ...m, ...Object.fromEntries(measured) }))
  }

  const onNodeDragStop = (_: unknown, node: Node) => {
    const rect: Rect = { ...node.position, ...sized(node.id) }
    const others = ids.filter((id) => id !== node.id).map((id) => ({ id, ...placed[id], ...sized(id) }))
    if (onNodeDrop) {
      const cx = rect.x + rect.w / 2
      const cy = rect.y + rect.h / 2
      const over = others.find((o) => cx >= o.x && cx <= o.x + o.w && cy >= o.y && cy <= o.y + o.h)
      onNodeDrop(node.id, over?.id ?? null)
    }
    setPositions({ ...placed, [node.id]: freeSpot(rect, others) })
    setLive({})
    scheduleSave()
  }

  const rearrange = () => {
    const auto = autoRef.current()
    const next = Object.fromEntries(ids.map((id) => [id, auto[id] ?? { x: 0, y: 0 }]))
    setPositions(next)
    setLive({})
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    save({ positions: next, folded: savedFolded })
  }

  const onEdgesChange = (changes: EdgeChange[]) => {
    const picks = changes.filter((c) => c.type === 'select')
    if (!picks.length) return
    setSelectedEdges((prev) => {
      const next = new Set(prev)
      for (const c of picks) {
        if (c.selected) next.add(c.id)
        else next.delete(c.id)
      }
      return next
    })
  }
  const rfEdges = edges.map((e) => (selectedEdges.has(e.id) ? { ...e, selected: true } : e))

  const exportAs = async (kind: 'png' | 'pdf') => {
    const viewport = container.current?.querySelector<HTMLElement>('.react-flow__viewport')
    if (!viewport) return
    const bounds = getNodesBounds(rfNodes)
    if (kind === 'png') await exportPng(viewport, bounds, title)
    else await exportPdf(viewport, bounds, { title, date: new Date(), legend }, title)
  }

  return (
    <Box>
      <ErrorAlert error={saveError} />
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', mb: 1 }}>
        <Button size="small" onClick={rearrange}>{t('Re-arrange')}</Button>
        <Button size="small" onClick={() => void exportAs('png')}>{t('Export PNG')}</Button>
        <Button size="small" onClick={() => void exportAs('pdf')}>{t('Export PDF')}</Button>
        <Button size="small" onClick={() => instance.current?.fitView()}>{t('Fit view')}</Button>
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
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            onConnect={props.onConnect}
            onEdgesDelete={props.onEdgesDelete}
            nodesConnectable={!!props.onConnect}
            onInit={(i) => {
              instance.current = i
            }}
            minZoom={0.1}
            fitView
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        ) : null}
      </Box>
    </Box>
  )
}
