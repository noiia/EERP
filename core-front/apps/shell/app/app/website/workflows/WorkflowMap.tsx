'use client'
import { useMemo, useState, type ReactNode } from 'react'
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
import { Background, Controls, MarkerType, Position, ReactFlow, type Connection, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { BannerScope, BannerSlot, byPrefixAndName, erpPath, FontAwesomeIcon, useT, ViewBanner } from '@eerp/core-front'
import { getPageLayout, saveLayout } from '@/website/editor-actions'
import { buildWorkflow, retarget, type NodeId, type WfEdge, type WfNode, type WfPage } from '@/website/workflow'
import { layoutWorkflow, problemLevels, type Level } from '@/website/workflow-layout'

// The Website app's workflow map: every page, the system pages and external hosts,
// with the links between them read from the pages' layouts (src/website/workflow.ts).
// Clicking a page opens it in the builder; dragging an edge's end onto another node
// re-targets that link in the source page's layout. React Flow is heavy: this module
// is only reached through LazyWorkflowMap, so it ships in its own chunk.

const COL_W = 280
const ROW_H = 120

type MapNode = Node<{ label: ReactNode; wf: WfNode }>
type MapEdge = Edge<{ wf: WfEdge }>

/** Errors red, warnings orange (the theme's palette), else `fallback`. */
const levelColor = (theme: Theme, level: Level | undefined, fallback: string) =>
  level === 'error' ? theme.palette.error.main : level === 'warning' ? theme.palette.warning.main : fallback

export function WorkflowMap({ pages: initial }: { pages: WfPage[] }) {
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

  const wf = useMemo(() => buildWorkflow(pages), [pages])
  const levels = useMemo(() => problemLevels(wf.nodes, wf.problems), [wf])

  const nodes: MapNode[] = useMemo(() => {
    const cells = layoutWorkflow(wf.nodes, wf.edges)
    return wf.nodes.map((n) => {
      const level = levels.nodes.get(n.id)
      const system = !n.id.startsWith('page:')
      return {
        id: n.id,
        position: { x: cells[n.id].col * COL_W, y: cells[n.id].row * ROW_H },
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
  }, [wf, levels, focus.nodeId, theme])

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
      label: t(e.label),
      data: { wf: e },
      selected,
      reconnectable: gate ? false : 'target',
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      style: { stroke, strokeWidth: selected ? 3 : level ? 2 : 1.25 },
      labelStyle: { fill: theme.palette.text.primary },
      labelBgStyle: { fill: theme.palette.background.paper },
    }
  }), [wf, levels, focus.edgeId, moved, theme, t])

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

  const label = (id?: NodeId) => wf.nodes.find((n) => n.id === id)?.label ?? ''

  return (
    <BannerScope>
      <BannerSlot />
      <ViewBanner status="error" open={error !== null} onClose={() => setError(null)}>{error}</ViewBanner>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ alignItems: 'stretch' }}>
        <Paper variant="outlined" sx={{ flex: 1, minWidth: 0, height: { xs: '60vh', md: '75vh' } }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodeClick={onNodeClick}
            onEdgeClick={(_, e) => setFocus({ edgeId: e.id })}
            onPaneClick={() => setFocus({})}
            onReconnect={(old, conn) => void onReconnect(old, conn)}
            edgesReconnectable={moved === null}
            nodesDraggable={false}
            nodesConnectable={false}
            colorMode={theme.palette.mode}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </Paper>
        <Box sx={{ width: { md: 320 }, flexShrink: 0 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>{t('Problems')}</Typography>
          {wf.problems.length === 0 ? (
            <Typography variant="body2" color="text.secondary">{t('No problems found.')}</Typography>
          ) : (
            <List dense disablePadding>
              {wf.problems.map((p, i) => (
                <ListItemButton
                  key={`${p.edgeId ?? p.nodeId}:${i}`}
                  selected={p.edgeId ? focus.edgeId === p.edgeId : focus.nodeId === p.nodeId}
                  onClick={() => setFocus(p.edgeId ? { edgeId: p.edgeId } : { nodeId: p.nodeId })}
                >
                  <ListItemIcon sx={{ minWidth: 28, color: levelColor(theme, p.level, '') }}>
                    <FontAwesomeIcon icon={byPrefixAndName.fas[p.level === 'error' ? 'circle-exclamation' : 'triangle-exclamation']} />
                  </ListItemIcon>
                  <ListItemText primary={t(p.message)} secondary={label(p.nodeId)} />
                </ListItemButton>
              ))}
            </List>
          )}
        </Box>
      </Stack>
    </BannerScope>
  )
}

function NodeLabel({ node }: { node: WfNode }) {
  const t = useT()
  if (node.id.startsWith('sys:')) return <Typography variant="body2" sx={{ fontWeight: 600 }}>{t(node.label)}</Typography>
  if (node.id.startsWith('ext:')) return <Typography variant="body2">{node.label}</Typography>
  return (
    <Box>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>{node.label}</Typography>
      {node.label !== `/${node.slug}` && <Typography variant="caption" color="text.secondary" component="div">/{node.slug}</Typography>}
      {node.missing && <Typography variant="caption" color="error" component="div">{t('Page not found')}</Typography>}
      {!node.missing && !node.published && <Typography variant="caption" color="warning.main" component="div">{t('Unpublished')}</Typography>}
    </Box>
  )
}
