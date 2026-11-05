'use client'
import { useMemo, useState, type ReactNode } from 'react'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import { useRouter } from 'next/navigation'
import Box from '@mui/material/Box'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useTheme, type Theme } from '@mui/material/styles'
import { Background, BaseEdge, Controls, getBezierPath, MarkerType, Position, ReactFlow, type Connection, type Edge, type EdgeProps, type EdgeTypes, type IsValidConnection, type Node, type NodeChange, type XYPosition } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { BannerScope, BannerSlot, byPrefixAndName, erpPath, FontAwesomeIcon, useT, ViewBanner } from '@eerp/core-front'
import { getPageLayout, saveLayout, saveWorkflowPositions, type WorkflowPositions } from '@/website/editor-actions'
import { buildWorkflow, retarget, type NodeId, type WfEdge, type WfNode, type WfPage } from '@/website/workflow'
import { addLink, canLinkTo, removable, removeLink, type NewLink } from '@/website/workflow-edit'
import { layoutWorkflow, problemLevels, type Level } from '@/website/workflow-layout'
import { bezierPoint, DEFAULT_NODE_SIZE, freeSpot, labelSize, placeLabels, separateBoxes, type LabelSpot, type Rect } from '@/website/workflow-collide'
import { NewLinkDialog, RemoveLinkDialog } from './WorkflowDialogs'

// The Website app's workflow map: every page, the system pages and external hosts,
// with the links between them read from the pages' layouts (src/website/workflow.ts).
// Clicking a page opens it in the builder. With website_page write rights, dragging an
// edge's end onto another node re-targets that link, dragging from a page's handle onto
// another node adds one (NewLinkDialog: which block holds it), and a selected edge can
// be removed — each a rewrite of the source page's layout (src/website/workflow-edit.ts).
// With settings:website:write, boxes can be moved; positions are shared by the team
// (website.workflow_layout), unsaved ones laid out automatically. React Flow is heavy:
// this module is only reached through LazyWorkflowMap, so it ships in its own chunk.
// Collisions (src/website/workflow-collide.ts): auto-placed boxes step aside from saved
// ones, a dropped box lands on the nearest free spot, and each arrow's label slides
// along its arrow (or off it) until it covers no other label and no box.

const COL_W = 280
const ROW_H = 120

type MapNode = Node<{ label: ReactNode; wf: WfNode }>
type MapEdge = Edge<{ wf: WfEdge; spot?: LabelSpot }>

/** Errors red, warnings orange (the theme's palette), else `fallback`. */
const levelColor = (theme: Theme, level: Level | undefined, fallback: string) =>
  level === 'error' ? theme.palette.error.main : level === 'warning' ? theme.palette.warning.main : fallback

export function WorkflowMap({ pages: initial, positions: savedPositions = {}, canEdit = false, canArrange = false }: {
  pages: WfPage[]
  /** Saved box positions by node id (shared setting); others are laid out automatically. */
  positions?: WorkflowPositions
  /** May rewrite page layouts: re-target, add and remove links. */
  canEdit?: boolean
  /** May move boxes and save their positions. */
  canArrange?: boolean
}) {
  const t = useT()
  const theme = useTheme()
  const router = useRouter()
  // Local copy, updated after a save; re-seeded when the server sends fresh pages.
  const [seed, setSeed] = useState(initial)
  const [pages, setPages] = useState(initial)
  if (seed !== initial) { setSeed(initial); setPages(initial) }
  const [moved, setMoved] = useState<{ edgeId: string; to: NodeId } | null>(null)
  const [focus, setFocus] = useState<{ nodeId?: NodeId; edgeId?: string }>({})
  const [error, setError] = useState<string | null>(null)
  const [positions, setPositions] = useState(savedPositions)
  const [live, setLive] = useState<Record<string, XYPosition>>({}) // boxes being dragged
  // The boxes' measured sizes, as React Flow reports them. Every node object the map
  // builds must carry its `measured`: a node rebuilt without it (each drag frame does)
  // is hidden, with its arrows, until re-measured — which never comes, its size unchanged.
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({})
  const [adding, setAdding] = useState<{ pageId: string; to: NodeId } | null>(null)
  const [removing, setRemoving] = useState<WfEdge | null>(null)

  const wf = useMemo(() => buildWorkflow(pages), [pages])
  const levels = useMemo(() => problemLevels(wf.nodes, wf.problems), [wf])

  const sizeOf = (id: string) => sizes[id] ?? DEFAULT_NODE_SIZE

  // Where every box is drawn: a dragged or saved box stays where it was put; the
  // automatic ones take the free spot nearest their grid cell.
  const placed = useMemo(() => {
    const cells = layoutWorkflow(wf.nodes, wf.edges)
    return separateBoxes(wf.nodes.map((n) => {
      const fixed = live[n.id] ?? positions[n.id]
      const { width, height } = sizes[n.id] ?? DEFAULT_NODE_SIZE
      return { id: n.id, ...(fixed ?? { x: cells[n.id].col * COL_W, y: cells[n.id].row * ROW_H }), w: width, h: height, fixed: !!fixed }
    }))
  }, [wf, live, positions, sizes])

  // Each label's spot along its arrow, clear of the other labels and of every box.
  const labelSpots = useMemo(() => {
    const box = (id: string): Rect => {
      const { width, height } = sizes[id] ?? DEFAULT_NODE_SIZE
      return { ...placed[id], w: width, h: height }
    }
    const boxes = wf.nodes.map((n) => box(n.id))
    return placeLabels(wf.edges.filter((e) => placed[e.from] && placed[e.to]).map((e) => {
      const s = box(e.from)
      const tg = box(moved?.edgeId === e.id ? moved.to : e.to)
      return { id: e.id, source: { x: s.x + s.w, y: s.y + s.h / 2 }, target: { x: tg.x, y: tg.y + tg.h / 2 }, ...labelSize(t(e.label)) }
    }), boxes)
  }, [wf, placed, sizes, moved, t])

  const nodes: MapNode[] = useMemo(() => {
    return wf.nodes.map((n) => {
      const level = levels.nodes.get(n.id)
      const system = !n.id.startsWith('page:')
      return {
        id: n.id,
        position: placed[n.id],
        measured: sizes[n.id],
        deletable: false,
        // Only an existing page can hold a new link (it's written into its layout).
        connectable: canEdit && !!n.pageId,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        selected: focus.nodeId === n.id,
        data: { wf: n, label: <NodeLabel node={n} /> },
        style: {
          borderColor: levelColor(theme, level, system ? theme.palette.divider : theme.palette.primary.main),
          borderWidth: level || focus.nodeId === n.id ? 2 : 1,
          borderStyle: n.missing || system ? 'dashed' : 'solid',
          background: theme.palette.background.paper,
          color: theme.palette.text.primary,
          cursor: n.pageId ? 'pointer' : 'default',
          boxShadow: focus.nodeId === n.id ? `0 0 0 3px ${theme.palette.primary.main}` : undefined,
        },
      }
    })
  }, [wf, levels, focus.nodeId, theme, placed, sizes, canEdit])

  const edges: MapEdge[] = useMemo(() => wf.edges.map((e) => {
    const level = levels.edges.get(e.id)
    const stroke = levelColor(theme, level, theme.palette.text.secondary)
    const selected = focus.edgeId === e.id
    // The page → Login half of a login gate is the gate itself, not a link: not draggable.
    const gate = e.key === 'after_login_slug' && e.to === 'sys:login'
    return {
      id: e.id,
      source: e.from,
      target: moved?.edgeId === e.id ? moved.to : e.to,
      type: 'labeled',
      label: t(e.label),
      data: { wf: e, spot: labelSpots[e.id] },
      selected,
      reconnectable: canEdit && !gate ? 'target' : false,
      deletable: canEdit && removable(e.key),
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      style: { stroke, strokeWidth: selected ? 3 : level ? 2 : 1.25 },
      labelStyle: { fill: theme.palette.text.primary },
      labelBgStyle: { fill: theme.palette.background.paper },
    }
  }), [wf, levels, focus.edgeId, moved, theme, t, labelSpots])

  const onNodeClick = (_: unknown, node: MapNode) => {
    const pageId = node.data.wf.pageId
    if (pageId) router.push(erpPath(`/website/pages/${pageId}/design`))
  }

  // Re-target: re-read the source page's layout (it may have changed since the map
  // loaded), rewrite that one link, save. A refused drop or a failure snaps back.
  const onReconnect = async (old: MapEdge, conn: Connection) => {
    const link = old.data?.wf
    const to = conn.target as NodeId
    if (!link || moved || to === link.to) return
    setError(null)
    setMoved({ edgeId: link.id, to })
    const fresh = await getPageLayout(link.pageId)
    if (!fresh) {
      setError(t('The page could not be loaded.'))
      return setMoved(null)
    }
    const next = retarget(fresh, link.blockId, link.key, to)
    if (next === fresh) return setMoved(null) // this link can't point there
    const err = await saveLayout(link.pageId, next)
    if (err !== null) {
      setError(err || t('Could not save.'))
      return setMoved(null)
    }
    setPages((ps) => ps.map((p) => (p.id === link.pageId ? { ...p, layout: next } : p)))
    setMoved(null)
    router.refresh()
  }

  // Live drag: React Flow reports positions, the map renders them until the drop.
  const onNodesChange = (changes: NodeChange<MapNode>[]) => {
    const moves = changes.flatMap((c) => (c.type === 'position' && c.position ? [[c.id, c.position] as const] : []))
    if (moves.length) setLive((l) => ({ ...l, ...Object.fromEntries(moves) }))
    const measured = changes.flatMap((c) => (c.type === 'dimensions' && c.dimensions ? [[c.id, c.dimensions] as const] : []))
    if (measured.length) setSizes((m) => ({ ...m, ...Object.fromEntries(measured) }))
  }

  // Drop: the box lands on the nearest spot clear of the others, then every position is
  // saved (only nodes still on the map, so the setting stays small).
  const onNodeDragStop = async (_: unknown, node: MapNode) => {
    const ids = new Set(wf.nodes.map((n) => n.id as string))
    const others = wf.nodes.filter((n) => n.id !== node.id).map((n) => ({ ...placed[n.id], w: sizeOf(n.id).width, h: sizeOf(n.id).height }))
    const spot = freeSpot({ ...node.position, w: sizeOf(node.id).width, h: sizeOf(node.id).height }, others)
    const next = Object.fromEntries(Object.entries({ ...positions, [node.id]: spot }).filter(([id]) => ids.has(id)))
    setPositions(next)
    setLive({})
    const err = await saveWorkflowPositions(next)
    if (err !== null) setError(err || t('Could not save the positions.'))
  }

  const arrangeAutomatically = async () => {
    setPositions({})
    const err = await saveWorkflowPositions({})
    if (err !== null) setError(err || t('Could not save the positions.'))
  }

  const nodeOf = (id?: NodeId) => wf.nodes.find((n) => n.id === id)
  const label = (id?: NodeId) => nodeOf(id)?.label ?? ''

  // A new arrow: from an existing page to a page that exists or a system page.
  const isValidConnection: IsValidConnection = (c) => {
    const from = nodeOf(c.source as NodeId)
    const to = nodeOf(c.target as NodeId)
    return !!from?.pageId && !!to && to.id !== from.id && canLinkTo(to.id, !!to.missing)
  }
  const onConnect = (c: Connection) => {
    const from = nodeOf(c.source as NodeId)
    if (from?.pageId && isValidConnection(c)) setAdding({ pageId: from.pageId, to: c.target as NodeId })
  }

  // Shared by add and remove: re-read the page's layout, apply `edit`, save.
  const rewrite = async (pageId: string, edit: (layout: WfPage['layout']) => WfPage['layout'], refused: string): Promise<boolean> => {
    setError(null)
    const fresh = await getPageLayout(pageId)
    if (!fresh) { setError(t('The page could not be loaded.')); return false }
    const next = edit(fresh)
    if (next === fresh) { setError(t(refused)); return false }
    const err = await saveLayout(pageId, next)
    if (err !== null) { setError(err || t('Could not save.')); return false }
    setPages((ps) => ps.map((p) => (p.id === pageId ? { ...p, layout: next } : p)))
    router.refresh()
    return true
  }

  const saveNewLink = async (link: NewLink) => {
    if (!adding) return
    if (await rewrite(adding.pageId, (l) => addLink(l, link), 'That block already has a link. Pick another one.')) setAdding(null)
  }

  const confirmRemove = async () => {
    if (!removing) return
    if (await rewrite(removing.pageId, (l) => removeLink(l, removing.blockId, removing.key), 'This link is no longer on the page.')) {
      setRemoving(null)
      setFocus({})
    }
  }

  const focusedEdge = wf.edges.find((e) => e.id === focus.edgeId)
  const showRemove = !!focusedEdge && canEdit && removable(focusedEdge.key)
  const showArrange = canArrange && Object.keys(positions).length > 0
  const addingPage = adding && pages.find((p) => p.id === adding.pageId)
  const addingTo = adding && nodeOf(adding.to)

  return (
    <BannerScope>
      <BannerSlot />
      <ViewBanner status="error" open={error !== null} onClose={() => setError(null)}>{error}</ViewBanner>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ alignItems: 'stretch' }}>
        <Paper variant="outlined" sx={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 320, height: { xs: '70dvh', md: '75vh' } }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            edgeTypes={edgeTypes}
            onNodeClick={onNodeClick}
            onEdgeClick={(_, e) => setFocus({ edgeId: e.id })}
            onPaneClick={() => setFocus({})}
            onReconnect={(old, conn) => void onReconnect(old, conn)}
            edgesReconnectable={canEdit && moved === null}
            nodesDraggable={canArrange}
            onNodesChange={onNodesChange}
            onNodeDragStop={(e, n) => void onNodeDragStop(e, n)}
            nodesConnectable={canEdit}
            isValidConnection={isValidConnection}
            onConnect={onConnect}
            // Delete/Backspace on a selected arrow asks first; nothing is deleted by React Flow itself.
            onBeforeDelete={async ({ edges: gone }) => {
              const e = gone.map((g) => (g as MapEdge).data?.wf).find((w) => w && removable(w.key))
              if (e) setRemoving(e)
              return false
            }}
            colorMode={theme.palette.mode}
            fitView
            // A phone is narrower than a few columns of boxes: zoom out far enough to show them all.
            minZoom={0.1}
            fitViewOptions={{ padding: 0.1 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
          {/* On the map, not in the side panel: under md the panel sits below the map, out of sight. */}
          {(showRemove || showArrange) && (
            <Stack direction="row" spacing={1} sx={{ position: 'absolute', top: 8, right: 8, zIndex: 5, flexWrap: 'wrap', justifyContent: 'flex-end', gap: 1, maxWidth: 'calc(100% - 16px)' }}>
              {showRemove && focusedEdge && (
                <Button color="error" variant="outlined" size="small" onClick={() => setRemoving(focusedEdge)}
                  startIcon={<FontAwesomeIcon icon={byPrefixAndName.fas.trash} />} sx={{ bgcolor: 'background.paper', '&:hover': { bgcolor: 'background.paper' } }}>
                  {t('Remove link')}
                </Button>
              )}
              {showArrange && (
                <Button variant="outlined" size="small" onClick={() => void arrangeAutomatically()} sx={{ bgcolor: 'background.paper', '&:hover': { bgcolor: 'background.paper' } }}>
                  {t('Arrange automatically')}
                </Button>
              )}
            </Stack>
          )}
        </Paper>
        <Box component="aside" aria-label={t('Map details')}
          sx={{ display: 'grid', gap: 2.5, alignContent: 'start', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))', md: 'minmax(0, 1fr)' }, width: { md: 320 }, flexShrink: 0 }}>
          <Box>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
              <Typography variant="subtitle2" component="h2">{t('Problems')}</Typography>
              {wf.problems.length > 0 && (
                <Chip size="small" label={wf.problems.length} color={wf.problems.some((p) => p.level === 'error') ? 'error' : 'warning'} sx={{ height: 20 }} />
              )}
            </Stack>
            {wf.problems.length === 0 ? (
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', color: 'text.secondary' }}>
                <Box component="span" sx={{ color: 'success.main' }}><FontAwesomeIcon icon={byPrefixAndName.fas.check} /></Box>
                <Typography variant="body2">{t('No problems found.')}</Typography>
              </Stack>
            ) : (
              <List dense disablePadding sx={{ mx: -1 }}>
                {wf.problems.map((p, i) => (
                  <ListItemButton
                    key={`${p.edgeId ?? p.nodeId}:${i}`}
                    selected={p.edgeId ? focus.edgeId === p.edgeId : focus.nodeId === p.nodeId}
                    onClick={() => setFocus(p.edgeId ? { edgeId: p.edgeId } : { nodeId: p.nodeId })}
                    sx={{ borderRadius: 1, alignItems: 'flex-start' }}
                  >
                    <ListItemIcon sx={{ minWidth: 28, mt: 0.5, color: levelColor(theme, p.level, '') }}>
                      <FontAwesomeIcon icon={byPrefixAndName.fas[p.level === 'error' ? 'circle-exclamation' : 'triangle-exclamation']} />
                    </ListItemIcon>
                    <ListItemText primary={t(p.message)} secondary={label(p.nodeId)} />
                  </ListItemButton>
                ))}
              </List>
            )}
          </Box>
          <MapLegend canEdit={canEdit} canArrange={canArrange} />
        </Box>
      </Stack>
      {addingPage && addingTo && (
        <NewLinkDialog page={addingPage} to={addingTo} pages={pages} onCancel={() => setAdding(null)} onSave={saveNewLink} />
      )}
      {removing && (
        <RemoveLinkDialog
          label={t(removing.label)}
          pageTitle={label(removing.from)}
          onCancel={() => setRemoving(null)}
          onConfirm={confirmRemove}
        />
      )}
    </BannerScope>
  )
}

/** A box's label: an icon naming its kind (page, home, system page, other site), its
 * title and path, and its state when it isn't a live published page. */
function NodeLabel({ node }: { node: WfNode }) {
  const t = useT()
  const kind = node.id.startsWith('sys:') ? 'sys' : node.id.startsWith('ext:') ? 'ext' : 'page'
  const icon = kind === 'sys' ? 'user' : kind === 'ext' ? 'globe' : node.slug === '' ? 'house' : 'file'
  const state = kind !== 'page' ? null : node.missing ? { text: t('Page not found'), color: 'error.main' } : !node.published ? { text: t('Unpublished'), color: 'warning.main' } : null
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', textAlign: 'left' }}>
      <Box aria-hidden sx={{ color: 'text.secondary', fontSize: 12, pt: 0.25 }}><FontAwesomeIcon icon={byPrefixAndName.fas[icon]} fixedWidth /></Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: kind === 'ext' ? 400 : 600, overflowWrap: 'anywhere' }}>{kind === 'sys' ? t(node.label) : node.label}</Typography>
        {kind === 'page' && node.label !== `/${node.slug}` && <Typography variant="caption" color="text.secondary" component="div">/{node.slug}</Typography>}
        {state && (
          <Typography variant="caption" component="div" sx={{ color: state.color, display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Box component="span" aria-hidden sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: state.color }} />{state.text}
          </Typography>
        )}
      </Box>
    </Stack>
  )
}

/** What the map's marks mean, and what the user may do with it (by their rights). */
function MapLegend({ canEdit, canArrange }: { canEdit: boolean; canArrange: boolean }) {
  const t = useT()
  const swatch = (border: string, style: 'solid' | 'dashed') => (
    <Box aria-hidden sx={{ width: 18, height: 12, borderRadius: 0.5, border: 1.5, borderStyle: style, borderColor: border, flexShrink: 0 }} />
  )
  const row = (mark: ReactNode, text: string) => (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>{mark}<Typography variant="caption" color="text.secondary">{text}</Typography></Stack>
  )
  return (
    <Box>
      <Typography variant="subtitle2" component="h2" sx={{ mb: 1 }}>{t('Legend')}</Typography>
      <Stack spacing={0.75}>
        {row(swatch('primary.main', 'solid'), t('A page of the site'))}
        {row(swatch('divider', 'dashed'), t('Login, sign-up, account, or another site'))}
        {row(swatch('warning.main', 'solid'), t('Needs attention'))}
        {row(swatch('error.main', 'solid'), t('Broken'))}
      </Stack>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1.5, mb: 0 }}>
        {[t('Click a page to open it in the builder.'),
          canArrange && t('Drag a box to move it.'),
          canEdit && t('Drag from the dot on a page’s right onto another page to add a link, or drag the end of an arrow to change where it leads. Select an arrow to remove it.'),
        ].filter(Boolean).join(' ')}
      </Typography>
    </Box>
  )
}

/** The map's arrow: React Flow's bezier, its label drawn at the spot the map chose for it
 * (`data.spot`, see placeLabels) instead of always the middle. */
function LabeledEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, ...rest }: EdgeProps<MapEdge>) {
  const [path, midX, midY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const spot = data?.spot
  const at = spot ? bezierPoint({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, spot.t) : { x: midX, y: midY }
  return (
    <BaseEdge
      id={rest.id}
      path={path}
      markerEnd={rest.markerEnd}
      style={rest.style}
      interactionWidth={rest.interactionWidth}
      label={rest.label}
      labelX={at.x}
      labelY={at.y + (spot?.dy ?? 0)}
      labelStyle={rest.labelStyle}
      labelShowBg={rest.labelShowBg}
      labelBgStyle={rest.labelBgStyle}
      labelBgPadding={rest.labelBgPadding}
      labelBgBorderRadius={rest.labelBgBorderRadius}
    />
  )
}

const edgeTypes: EdgeTypes = { labeled: LabeledEdge }
