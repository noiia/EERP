'use client'
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import IconButton from '@mui/material/IconButton'
import Typography from '@mui/material/Typography'
import { GRID_UNIT, type Tile } from '../api/graph'
import type { SerializedError } from '../api/errors'
import { usePermission } from '../auth/Can'
import { useT } from '../i18n/translate'
import type { ViewDescriptor } from './descriptor'
import { ErrorAlert } from './error-alert'
import { useGraphOps } from './graph-ops'
import { GraphWidgetBody } from './graph-widgets'
import { WidgetConfigDialog, type WidgetDraft } from './graph-widget-config'
import type { HasId } from './stores'

// Graph display mode (docs/roadmaps/list-view-modes.md): a 30px-unit canvas
// of resizable/movable tiles. Layout persists through GraphOps (a context the
// host provides, like RelationOps) — unlike Kanban/Calendar, a tile move is
// workspace SETTINGS state (ADR-006), not an entity record write, so it does
// NOT go through EntityActions. Tile widget BODIES aggregate over `records`,
// the SAME already-fetched page TreeRenderer's other modes render from — no
// new fetch, except the `list` widget, which reuses RelationOps for a real
// server-side filtered query (see graph-widgets.tsx).

const MIN_TILE_UNITS = 2 // 60px — small enough to fit many, big enough to grab.
const DEFAULT_TILE_W = 6 // 180px
const DEFAULT_TILE_H = 6 // 180px

interface DragState {
  id: string
  kind: 'move' | 'resize'
  startX: number
  startY: number
  originX: number
  originY: number
  originW: number
  originH: number
}

/** Where a newly added tile lands: below the lowest existing tile, at the
 * left edge — a simple, deterministic stacking order, not a bin-packer. */
function nextTilePosition(tiles: Tile[]): { x: number; y: number } {
  return { x: 0, y: tiles.reduce((max, tl) => Math.max(max, tl.y + tl.h), 0) }
}

export interface GraphRendererProps<T extends HasId> {
  descriptor: ViewDescriptor<T>
  /** The same already-fetched page TreeRenderer's other modes render from —
   * xy/pie/stat aggregate over this, client-side (v1 — see the roadmap's
   * "Aggregation, v1" contract and Pitfalls). */
  records: T[]
  /** Go's total row count, when known — undefined is treated as "unknown",
   * not "complete", so the partial-data badge stays conservative. */
  recordTotal?: number
}

export function GraphRenderer<T extends HasId>({ descriptor, records, recordTotal }: GraphRendererProps<T>) {
  const t = useT()
  const graphOps = useGraphOps()
  const canEdit = usePermission('settings:views:write')

  // null = still loading; [] once the read resolves (even to an empty canvas).
  const [saved, setSaved] = useState<Tile[] | null>(null)
  // null = view mode; a non-null array is the in-progress edit draft.
  const [draft, setDraft] = useState<Tile[] | null>(null)
  const [error, setError] = useState<SerializedError | null>(null)
  const [saving, setSaving] = useState(false)
  const [dragState, setDragState] = useState<DragState | null>(null)
  // Which tile the config dialog is editing, or 'new' to add one, or null (closed).
  const [dialogTarget, setDialogTarget] = useState<Tile | 'new' | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!graphOps) {
      setSaved([])
      return
    }
    graphOps.get(descriptor.entity).then(
      (layout) => {
        if (!cancelled) setSaved(layout.tiles)
      },
      () => {
        if (!cancelled) setSaved([])
      },
    )
    return () => {
      cancelled = true
    }
  }, [graphOps, descriptor.entity])

  const editing = draft != null
  const tiles = editing ? draft : (saved ?? [])

  function startEdit() {
    setError(null)
    setDraft(saved ?? [])
  }

  function cancelEdit() {
    setDraft(null)
    setError(null)
  }

  async function saveEdit() {
    if (!graphOps || !draft) return
    setSaving(true)
    setError(null)
    const result = await graphOps.save(descriptor.entity, draft)
    setSaving(false)
    if (result.ok) {
      setSaved(draft)
      setDraft(null)
    } else {
      setError({ code: 'VALIDATION_ERROR', message: result.message })
    }
  }

  function submitWidget(target: Tile | 'new', wd: WidgetDraft) {
    if (!draft) return
    if (target === 'new') {
      const { x, y } = nextTilePosition(draft)
      const tile: Tile = {
        id: crypto.randomUUID(),
        x,
        y,
        w: DEFAULT_TILE_W,
        h: DEFAULT_TILE_H,
        type: wd.type,
        title: wd.title || undefined,
        config: wd.config,
      }
      setDraft([...draft, tile])
    } else {
      setDraft(draft.map((tl) => (tl.id === target.id ? { ...tl, ...wd, title: wd.title || undefined } : tl)))
    }
    setDialogTarget(null)
  }

  function removeTile(id: string) {
    setDraft((prev) => prev?.filter((tl) => tl.id !== id) ?? null)
  }

  function beginDrag(kind: 'move' | 'resize', tile: Tile, e: ReactMouseEvent) {
    if (!editing) return
    e.preventDefault()
    e.stopPropagation()
    setDragState({
      id: tile.id,
      kind,
      startX: e.clientX,
      startY: e.clientY,
      originX: tile.x,
      originY: tile.y,
      originW: tile.w,
      originH: tile.h,
    })
  }

  // Pointer tracking lives on `window` (standard drag pattern: the pointer
  // routinely leaves the tile/handle mid-drag) and reads only clientX/clientY
  // DELTAS, never measured layout (getBoundingClientRect) — jsdom reports
  // event coordinates fine even though it never computes real layout, which
  // is what makes this hand-rolled approach fully testable without a real
  // browser (see the roadmap's Phase 4 implementation notes for why this
  // isn't react-grid-layout).
  useEffect(() => {
    if (!dragState) return
    const ds = dragState
    function onMove(e: MouseEvent) {
      const dxUnits = Math.round((e.clientX - ds.startX) / GRID_UNIT)
      const dyUnits = Math.round((e.clientY - ds.startY) / GRID_UNIT)
      setDraft(
        (prev) =>
          prev?.map((tl) => {
            if (tl.id !== ds.id) return tl
            if (ds.kind === 'move') {
              return { ...tl, x: Math.max(0, ds.originX + dxUnits), y: Math.max(0, ds.originY + dyUnits) }
            }
            return {
              ...tl,
              w: Math.max(MIN_TILE_UNITS, ds.originW + dxUnits),
              h: Math.max(MIN_TILE_UNITS, ds.originH + dyUnits),
            }
          }) ?? null,
      )
    }
    function onUp() {
      setDragState(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragState])

  if (saved == null) return null // a settings read resolves fast; nothing to show yet.

  if (!graphOps) {
    return (
      <Typography color="text.secondary">
        {t('Graph layouts are not available in this deployment.')}
      </Typography>
    )
  }

  const addPosition = nextTilePosition(draft ?? [])
  const canvasCols = Math.max(12, tiles.reduce((max, tl) => Math.max(max, tl.x + tl.w), 0) + 2)
  const canvasRows =
    Math.max(8, tiles.reduce((max, tl) => Math.max(max, tl.y + tl.h), 0) + (editing ? DEFAULT_TILE_H : 0) + 2)

  return (
    <Box>
      {error ? <ErrorAlert error={error} /> : null}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mb: 1 }}>
        {editing ? (
          <>
            <Button size="small" onClick={cancelEdit} disabled={saving}>
              {t('Cancel')}
            </Button>
            <Button size="small" variant="contained" onClick={() => void saveEdit()} disabled={saving}>
              {saving ? t('Saving…') : t('Save')}
            </Button>
          </>
        ) : canEdit ? (
          <Button size="small" onClick={startEdit}>
            {t('Edit')}
          </Button>
        ) : null}
      </Box>
      <Box
        sx={{
          position: 'relative',
          width: canvasCols * GRID_UNIT,
          height: canvasRows * GRID_UNIT,
          overflow: 'auto',
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 1,
          // The "grid of 30px squares" made visible, not just used for math.
          backgroundImage:
            'linear-gradient(to right, rgba(127,127,127,0.15) 1px, transparent 1px), ' +
            'linear-gradient(to bottom, rgba(127,127,127,0.15) 1px, transparent 1px)',
          backgroundSize: `${GRID_UNIT}px ${GRID_UNIT}px`,
        }}
      >
        {tiles.map((tile) => (
          <Card
            key={tile.id}
            data-testid={`graph-tile-${tile.id}`}
            variant="outlined"
            // Position/size are per-instance, dynamically computed values —
            // a plain `style` prop, not `sx` (a CSS-in-JS class), so tests
            // can assert exact pixel geometry via getComputedStyle without
            // depending on jsdom's stylesheet-matching.
            style={{
              position: 'absolute',
              left: tile.x * GRID_UNIT,
              top: tile.y * GRID_UNIT,
              width: tile.w * GRID_UNIT,
              height: tile.h * GRID_UNIT,
            }}
            sx={{ display: 'flex', flexDirection: 'column' }}
          >
            <Box
              data-testid={`graph-tile-header-${tile.id}`}
              onMouseDown={(e) => beginDrag('move', tile, e)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                px: 1,
                py: 0.5,
                bgcolor: 'action.hover',
                cursor: editing ? 'grab' : 'default',
              }}
            >
              <Typography variant="caption" noWrap>
                {tile.title || t(tile.type)}
              </Typography>
              {editing ? (
                <Box sx={{ display: 'flex', flexShrink: 0 }}>
                  <IconButton
                    size="small"
                    aria-label={t('Configure widget')}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => setDialogTarget(tile)}
                  >
                    ✎
                  </IconButton>
                  <IconButton
                    size="small"
                    aria-label={t('Remove widget')}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => removeTile(tile.id)}
                  >
                    ×
                  </IconButton>
                </Box>
              ) : null}
            </Box>
            <CardContent sx={{ flex: 1, p: 1, overflow: 'auto', '&:last-child': { pb: 1 } }}>
              <GraphWidgetBody tile={tile} descriptor={descriptor} records={records} recordTotal={recordTotal} />
            </CardContent>
            {editing ? (
              <Box
                data-testid={`graph-tile-resize-${tile.id}`}
                onMouseDown={(e) => beginDrag('resize', tile, e)}
                sx={{
                  position: 'absolute',
                  right: 0,
                  bottom: 0,
                  width: 14,
                  height: 14,
                  cursor: 'nwse-resize',
                  bgcolor: 'action.selected',
                }}
              />
            ) : null}
          </Card>
        ))}

        {editing ? (
          <Box
            sx={{
              position: 'absolute',
              left: addPosition.x * GRID_UNIT,
              top: addPosition.y * GRID_UNIT,
              width: DEFAULT_TILE_W * GRID_UNIT,
              height: DEFAULT_TILE_H * GRID_UNIT,
            }}
          >
            <Button fullWidth sx={{ height: '100%' }} variant="outlined" onClick={() => setDialogTarget('new')}>
              {t('+ Add widget')}
            </Button>
          </Box>
        ) : null}
      </Box>

      <WidgetConfigDialog
        open={dialogTarget != null}
        descriptor={descriptor}
        initial={
          dialogTarget && dialogTarget !== 'new'
            ? { type: dialogTarget.type, title: dialogTarget.title ?? '', config: dialogTarget.config }
            : null
        }
        onClose={() => setDialogTarget(null)}
        onSubmit={(wd) => dialogTarget && submitWidget(dialogTarget, wd)}
      />
    </Box>
  )
}
