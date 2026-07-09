'use client'
import { useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import ReactGridLayout, { useContainerWidth, verticalCompactor, type Layout } from 'react-grid-layout'
import { GRID_UNIT, type Tile, type TileType } from '../api/graph'
import type { SerializedError } from '../api/errors'
import { usePermission } from '../auth/Can'
import { useT } from '../i18n/translate'
import type { ViewDescriptor } from './descriptor'
import { ErrorAlert } from './error-alert'
import { useGraphOps } from './graph-ops'
import { GraphWidgetBody } from './graph-widgets'
import { WidgetConfigDialog, type WidgetDraft } from './graph-widget-config'
import type { HasId } from './stores'

// Graph display mode (docs/roadmaps/list-view-modes.md, Phase 4.6): a
// react-grid-layout (RGL) v2 canvas of resizable/movable tiles. Layout persists
// through GraphOps (a context the host provides, like RelationOps) — unlike
// Kanban/Calendar, a tile move is workspace SETTINGS state (ADR-006), not an
// entity record write, so it does NOT go through EntityActions. Tile widget
// BODIES aggregate over `records`, the SAME already-fetched page TreeRenderer's
// other modes render from — no new fetch, except the `list` widget, which
// reuses RelationOps for a real server-side filtered query (see
// graph-widgets.tsx) — none of that changed by this migration.

/** Per-type minimum tile size (grid units), replacing the old uniform floor —
 * reverse-engineered from each widget's actual rendered pixel dimensions in
 * graph-widgets.tsx (XyChart's fixed 96px-tall svg, PieChart's 84px donut +
 * legend column, a compact DataGrid needing a header + a row or two). Tune
 * visually if a widget still reads as cramped; not load-bearing for
 * correctness. */
const TILE_MIN_SIZE: Record<TileType, { minW: number; minH: number }> = {
  stat: { minW: 2, minH: 2 },
  xy: { minW: 4, minH: 5 },
  bar: { minW: 4, minH: 5 },
  pie: { minW: 5, minH: 5 },
  list: { minW: 4, minH: 4 },
}

const DEFAULT_TILE_W = 6 // 180px
const DEFAULT_TILE_H = 6 // 180px

/** Where a newly added tile lands: below the lowest existing (visible) tile,
 * at the left edge — a simple, deterministic initial guess; `verticalCompactor`
 * settles it into its final resting slot on the next render regardless. */
function nextTilePosition(tiles: Tile[]): { x: number; y: number } {
  return { x: 0, y: tiles.reduce((max, tl) => Math.max(max, tl.y + tl.h), 0) }
}

/**
 * Merge react-grid-layout's reported positions back onto our tiles by id.
 * Hidden tiles are never passed to RGL (filtered out before rendering), so
 * they never appear in `rglLayout` — their geometry must stay untouched, not
 * reset or dropped. Exported for direct unit testing.
 */
export function applyRGLLayout(tiles: Tile[], rglLayout: Layout): Tile[] {
  const byId = new Map(rglLayout.map((item) => [item.i, item]))
  return tiles.map((tl) => {
    const item = byId.get(tl.id)
    return item ? { ...tl, x: item.x, y: item.y, w: item.w, h: item.h } : tl
  })
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
  const { width: containerWidth, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true })

  // null = still loading; [] once the read resolves (even to an empty canvas).
  const [saved, setSaved] = useState<Tile[] | null>(null)
  // null = view mode; a non-null array is the in-progress edit draft.
  const [draft, setDraft] = useState<Tile[] | null>(null)
  const [error, setError] = useState<SerializedError | null>(null)
  const [saving, setSaving] = useState(false)
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
  const visibleTiles = tiles.filter((tl) => !tl.hidden)
  const hiddenTiles = editing ? (draft ?? []).filter((tl) => tl.hidden) : []

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
      const { x, y } = nextTilePosition(draft.filter((tl) => !tl.hidden))
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

  function hideTile(id: string) {
    setDraft((prev) => prev?.map((tl) => (tl.id === id ? { ...tl, hidden: true } : tl)) ?? null)
  }

  function restoreTile(id: string) {
    setDraft((prev) => prev?.map((tl) => (tl.id === id ? { ...tl, hidden: false } : tl)) ?? null)
  }

  function handleLayoutChange(newLayout: Layout) {
    if (!editing) return
    setDraft((prev) => (prev ? applyRGLLayout(prev, newLayout) : prev))
  }

  const canvasCols = Math.max(4, Math.round(containerWidth / GRID_UNIT))
  const rglLayout: Layout = visibleTiles.map((tl) => ({
    i: tl.id,
    x: tl.x,
    y: tl.y,
    w: tl.w,
    h: tl.h,
    minW: TILE_MIN_SIZE[tl.type].minW,
    minH: TILE_MIN_SIZE[tl.type].minH,
  }))

  const loading = saved == null // a settings read resolves fast; nothing to show yet.
  const notAvailable = !loading && !graphOps
  const ready = !loading && !notAvailable

  // The `containerRef` Box below is rendered UNCONDITIONALLY, on every branch,
  // including while loading/not-available — never behind an early return. RGL's
  // useContainerWidth attaches its ResizeObserver in an effect keyed on a ref
  // whose identity only changes once `mounted` first flips true; if this Box
  // only entered the tree on a LATER render (e.g. behind `if (loading) return
  // null`), the observer would have already attached to nothing on the first
  // render and `mounted` would never become true — a real bug this component
  // hit once, not a hypothetical.
  return (
    <Box>
      {notAvailable ? (
        <Typography color="text.secondary">
          {t('Graph layouts are not available in this deployment.')}
        </Typography>
      ) : null}
      {ready ? (
        <>
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
        </>
      ) : null}
      <Box ref={containerRef} sx={{ position: 'relative', width: '100%' }}>
        {ready && editing ? (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              width: containerWidth,
              pointerEvents: 'none',
              // The "grid of 30px squares" made visible, not just used for math.
              backgroundImage:
                'linear-gradient(to right, rgba(127,127,127,0.15) 1px, transparent 1px), ' +
                'linear-gradient(to bottom, rgba(127,127,127,0.15) 1px, transparent 1px)',
              backgroundSize: `${GRID_UNIT}px ${GRID_UNIT}px`,
            }}
          />
        ) : null}
        {ready && mounted ? (
          <ReactGridLayout
            layout={rglLayout}
            width={containerWidth}
            gridConfig={{ cols: canvasCols, rowHeight: GRID_UNIT, margin: [0, 0], containerPadding: [0, 0] }}
            // No dragConfig.handle: the whole tile is the drag surface (there's no
            // dedicated header bar anymore) — dragConfig.cancel still excludes the
            // floating configure/hide buttons, and RGL itself always excludes its
            // own resize handles regardless.
            dragConfig={{ enabled: editing, cancel: '.graph-tile-no-drag' }}
            resizeConfig={{ enabled: editing, handles: ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] }}
            compactor={verticalCompactor}
            onLayoutChange={handleLayoutChange}
          >
            {visibleTiles.map((tile) => (
              // This OUTER element is the one RGL clones its computed position/size
              // onto (the full occupied grid cell, positioned absolute by RGL itself
              // — that alone already makes it a valid containing block, nothing extra
              // needed here) — kept bare (no border/radius/background) so the VISIBLE
              // Card below can be inset 5px from it on every side, leaving a real
              // empty gap between adjacent tiles that the grid math itself never sees
              // (drag/resize/compaction still operate on the full, un-inset cell).
              <Box key={tile.id} data-testid={`graph-tile-${tile.id}`}>
                <Card
                  variant="outlined"
                  sx={{
                    position: 'absolute',
                    inset: '5px',
                    borderRadius: '16px',
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column',
                    cursor: editing ? 'grab' : 'default',
                  }}
                >
                  <Typography
                    variant="subtitle1"
                    noWrap
                    sx={{
                      position: 'absolute',
                      top: 8,
                      left: 12,
                      right: editing ? 64 : 12,
                      zIndex: 1,
                      fontWeight: 600,
                      pointerEvents: 'none',
                    }}
                  >
                    {tile.title || t(tile.type)}
                  </Typography>
                  {editing ? (
                    <Box
                      className="graph-tile-no-drag"
                      sx={{ position: 'absolute', top: 2, right: 2, zIndex: 2, display: 'flex' }}
                    >
                      <IconButton
                        size="small"
                        aria-label={t('Configure widget')}
                        onClick={() => setDialogTarget(tile)}
                      >
                        ✎
                      </IconButton>
                      <IconButton size="small" aria-label={t('Hide widget')} onClick={() => hideTile(tile.id)}>
                        ×
                      </IconButton>
                    </Box>
                  ) : null}
                  <CardContent
                    sx={{
                      flex: 1,
                      minHeight: 0,
                      minWidth: 0,
                      // A small inset on every side so chart content, a "No data"/"No
                      // matching records" message, etc. never sit flush against the
                      // tile's edges or rounded corners — top stays wider (30px) to
                      // clear the floating title, per the fix above.
                      px: 1,
                      pb: 1,
                      pt: '30px',
                      '&:last-child': { pb: 1 },
                    }}
                  >
                    <GraphWidgetBody
                      tile={tile}
                      descriptor={descriptor}
                      records={records}
                      recordTotal={recordTotal}
                    />
                  </CardContent>
                </Card>
              </Box>
            ))}
          </ReactGridLayout>
        ) : null}
      </Box>

      {ready && editing ? (
        <Button variant="outlined" sx={{ mt: 1 }} onClick={() => setDialogTarget('new')}>
          {t('+ Add widget')}
        </Button>
      ) : null}

      {ready && editing && hiddenTiles.length > 0 ? (
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', mt: 1, alignItems: 'center' }}>
          <Typography variant="caption" color="text.secondary">
            {t('Hidden widgets:')}
          </Typography>
          {hiddenTiles.map((tl) => (
            <Chip
              key={tl.id}
              data-testid={`graph-hidden-chip-${tl.id}`}
              size="small"
              label={tl.title || t(tl.type)}
              onClick={() => restoreTile(tl.id)}
            />
          ))}
        </Stack>
      ) : null}

      {ready ? (
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
      ) : null}
    </Box>
  )
}
