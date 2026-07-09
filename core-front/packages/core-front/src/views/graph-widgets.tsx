'use client'
import { useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { DataGrid, type GridColDef } from '@mui/x-data-grid'
import type { Tile } from '../api/graph'
import { useRelationOps, type RelationRecord } from './relation-ops'
import {
  OTHER_LABEL,
  pieSlices,
  statValue,
  xyPoints,
  type FullAggregate,
  type NumericAggregate,
  type PieSlice,
  type XyPoint,
} from './graph-aggregate'
import { fieldLabel, type ViewDescriptor } from './descriptor'
import { useNumberFormat } from './format-store'
import { useT } from '../i18n/translate'
import { useUiStore } from './ui-store'
import type { HasId } from './stores'

// Graph tile widget BODIES (docs/roadmaps/list-view-modes.md, Phase 5) — what
// Phase 4's scaffold left as a type-labeled placeholder. xy/pie/stat aggregate
// CLIENT-SIDE over the already-fetched page (the same `records` Kanban/
// Calendar render from — no new fetch); `list` is the one exception, reusing
// RelationOps (an entity-generic Server Action the host already provides) to
// run a real server-side `filter[col]=value` query, per the contracts table.

// ── categorical palette (dataviz skill's validated reference instance —
// this project has no chart-specific categorical palette of its own yet, only
// a 5-slot UI brand palette; see references/palette.md for the source and
// validation status) ─────────────────────────────────────────────────────────

const CATEGORICAL_LIGHT = [
  '#2a78d6',
  '#1baf7a',
  '#eda100',
  '#008300',
  '#4a3aa7',
  '#e34948',
  '#e87ba4',
  '#eb6834',
]
const CATEGORICAL_DARK = [
  '#3987e5',
  '#199e70',
  '#c98500',
  '#008300',
  '#9085e9',
  '#e66767',
  '#d55181',
  '#d95926',
]
const CHROME_LIGHT = { primaryInk: '#0b0b0b', mutedInk: '#898781', baseline: '#c3c2b7' }
const CHROME_DARK = { primaryInk: '#ffffff', mutedInk: '#898781', baseline: '#383835' }

function useGraphPalette() {
  const theme = useUiStore((s) => s.theme)
  return theme === 'dark'
    ? { categorical: CATEGORICAL_DARK, chrome: CHROME_DARK }
    : { categorical: CATEGORICAL_LIGHT, chrome: CHROME_LIGHT }
}

function colorFor(index: number, palette: readonly string[]): string {
  return palette[index % palette.length]!
}

// ── shared bits ────────────────────────────────────────────────────────────

const AGGREGATE_LABELS: Record<FullAggregate, string> = {
  sum: 'Sum',
  avg: 'Average',
  mean: 'Mean',
  count: 'Count',
  median: 'Median',
}

/**
 * Visible when the tile's `records` are a page_size-truncated slice of a
 * larger total — never silently aggregate a partial set unlabeled (the
 * roadmap's Phase 5 contract). `total` may be undefined ("unknown"), which
 * is treated the same as "possibly partial", not "definitely complete".
 */
function PartialDataBadge({ shown, total }: { shown: number; total: number | undefined }) {
  const t = useT()
  if (total == null || total <= shown) return null
  return (
    <Chip
      size="small"
      color="warning"
      variant="outlined"
      label={t(`Partial data: ${shown} of ${total}`)}
      sx={{ mb: 0.5, alignSelf: 'flex-start' }}
    />
  )
}

function NoData() {
  const t = useT()
  return (
    <Typography variant="caption" color="text.secondary">
      {t('No data')}
    </Typography>
  )
}

// ── stat ─────────────────────────────────────────────────────────────────

export function StatWidgetBody<T extends HasId>({
  tile,
  records,
  recordTotal,
}: {
  tile: Tile
  records: T[]
  recordTotal: number | undefined
}) {
  const t = useT()
  const { format } = useNumberFormat()
  const config = tile.config as { field?: string; aggregate?: FullAggregate }
  if (!config.field || !config.aggregate) return <NoData />
  const value = statValue(records, { field: config.field, aggregate: config.aggregate })
  return (
    <Stack spacing={0.25} sx={{ height: '100%' }}>
      <PartialDataBadge shown={records.length} total={recordTotal} />
      <Typography variant="caption" color="text.secondary">
        {t(AGGREGATE_LABELS[config.aggregate])}
      </Typography>
      <Typography variant="h5" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {format(value, { decimals: 2 })}
      </Typography>
    </Stack>
  )
}

// ── xy (line chart, one series — see dataviz: a single series needs no legend) ──

function XyChart({ points, format }: { points: XyPoint[]; format: (v: number) => string }) {
  const t = useT()
  const palette = useGraphPalette()
  if (points.length === 0) return <NoData />

  const width = 260
  const height = 96
  const padding = { top: 6, right: 6, bottom: 6, left: 6 }
  const innerW = width - padding.left - padding.right
  const innerH = height - padding.top - padding.bottom
  const values = points.map((p) => p.value)
  const min = Math.min(...values, 0)
  const max = Math.max(...values, 0)
  const range = max - min || 1
  const xStep = points.length > 1 ? innerW / (points.length - 1) : 0
  const coords = points.map((p, i) => ({
    x: padding.left + (points.length > 1 ? i * xStep : innerW / 2),
    y: padding.top + innerH - ((p.value - min) / range) * innerH,
    point: p,
  }))
  const baselineY = padding.top + innerH - ((0 - min) / range) * innerH
  const seriesColor = colorFor(0, palette.categorical)

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={t('Line chart')}>
      <line
        x1={padding.left}
        y1={baselineY}
        x2={width - padding.right}
        y2={baselineY}
        stroke={palette.chrome.baseline}
        strokeWidth={1}
      />
      <polyline
        points={coords.map((c) => `${c.x},${c.y}`).join(' ')}
        fill="none"
        stroke={seriesColor}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {coords.map((c) => (
        <circle key={c.point.bucket} cx={c.x} cy={c.y} r={4} fill={seriesColor}>
          <title>{`${c.point.bucket}: ${format(c.point.value)}`}</title>
        </circle>
      ))}
    </svg>
  )
}

export function XyWidgetBody<T extends HasId>({
  tile,
  records,
  recordTotal,
}: {
  tile: Tile
  records: T[]
  recordTotal: number | undefined
}) {
  const { format } = useNumberFormat()
  const config = tile.config as {
    xField?: string
    yField?: string
    aggregate?: NumericAggregate
    bucket?: 'day' | 'week' | 'month'
  }
  if (!config.xField || !config.yField || !config.aggregate || !config.bucket) return <NoData />
  const points = xyPoints(records, {
    xField: config.xField,
    yField: config.yField,
    aggregate: config.aggregate,
    bucket: config.bucket,
  })
  return (
    <Stack spacing={0.5} sx={{ height: '100%' }}>
      <PartialDataBadge shown={records.length} total={recordTotal} />
      <XyChart points={points} format={(v) => format(v, { decimals: 1 })} />
    </Stack>
  )
}

// ── pie (donut, categorical hues in fixed order + a legend) ────────────────

function PieChart({ slices, format }: { slices: PieSlice[]; format: (v: number) => string }) {
  const t = useT()
  const palette = useGraphPalette()
  const total = slices.reduce((sum, s) => sum + s.value, 0)
  if (total <= 0) return <NoData />

  const size = 84
  const strokeWidth = 20
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  let offset = 0

  return (
    <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', minWidth: 0 }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={t('Pie chart')}
        style={{ flexShrink: 0 }}
      >
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {slices.map((slice, i) => {
            const length = (slice.value / total) * circumference
            const dashoffset = -offset
            offset += length
            const color = slice.label === OTHER_LABEL ? palette.chrome.mutedInk : colorFor(i, palette.categorical)
            return (
              <circle
                key={slice.label}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={color}
                strokeWidth={strokeWidth}
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={dashoffset}
              >
                <title>{`${slice.label === OTHER_LABEL ? t('Other') : slice.label}: ${format(slice.value)}`}</title>
              </circle>
            )
          })}
        </g>
      </svg>
      <Stack spacing={0.25} sx={{ minWidth: 0 }}>
        {slices.map((slice, i) => (
          <Stack key={slice.label} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                flexShrink: 0,
                bgcolor:
                  slice.label === OTHER_LABEL ? palette.chrome.mutedInk : colorFor(i, palette.categorical),
              }}
            />
            <Typography variant="caption" noWrap color="text.secondary">
              {slice.label === OTHER_LABEL ? t('Other') : slice.label}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  )
}

export function PieWidgetBody<T extends HasId>({
  tile,
  records,
  recordTotal,
}: {
  tile: Tile
  records: T[]
  recordTotal: number | undefined
}) {
  const { format } = useNumberFormat()
  const config = tile.config as { groupByField?: string; valueField?: string; aggregate?: 'sum' | 'count' }
  if (!config.groupByField || !config.aggregate) return <NoData />
  const slices = pieSlices(records, {
    groupByField: config.groupByField,
    valueField: config.valueField,
    aggregate: config.aggregate,
  })
  return (
    <Stack spacing={0.5} sx={{ height: '100%' }}>
      <PartialDataBadge shown={records.length} total={recordTotal} />
      <PieChart slices={slices} format={(v) => format(v, { decimals: config.aggregate === 'count' ? 0 : 1 })} />
    </Stack>
  )
}

// ── list (server-filtered, via RelationOps — not the client-side page) ─────

const LIST_WIDGET_PAGE_SIZE = 20

export function ListWidgetBody<T extends HasId>({
  tile,
  descriptor,
}: {
  tile: Tile
  descriptor: ViewDescriptor<T>
}) {
  const t = useT()
  const ops = useRelationOps()
  const config = tile.config as { filterField?: string; filterValue?: string; displayFields?: string[] }
  const [rows, setRows] = useState<RelationRecord[] | null>(null)

  useEffect(() => {
    if (!ops || !config.filterField || config.filterValue == null) {
      setRows([])
      return
    }
    let cancelled = false
    ops
      .list(descriptor.entity, {
        filter: { [config.filterField]: config.filterValue },
        pageSize: LIST_WIDGET_PAGE_SIZE,
      })
      .then((found) => {
        if (!cancelled) setRows(found)
      })
      .catch(() => {
        if (!cancelled) setRows([])
      })
    return () => {
      cancelled = true
    }
  }, [ops, descriptor.entity, config.filterField, config.filterValue])

  if (!ops) {
    return (
      <Typography variant="caption" color="text.secondary">
        {t('Related-record lookups are not available in this deployment.')}
      </Typography>
    )
  }
  if (rows == null) return null

  const displayFields = config.displayFields ?? []
  const fieldsByName = new Map(descriptor.fields.map((f) => [f.name, f]))
  const columns: GridColDef[] = displayFields.map((name) => {
    const field = fieldsByName.get(name)
    return { field: name, headerName: field ? t(fieldLabel(field)) : name, flex: 1 }
  })

  if (rows.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary">
        {t('No matching records.')}
      </Typography>
    )
  }
  return <DataGrid rows={rows} columns={columns} autoHeight hideFooter density="compact" />
}

// ── dispatcher ───────────────────────────────────────────────────────────

export function GraphWidgetBody<T extends HasId>({
  tile,
  descriptor,
  records,
  recordTotal,
}: {
  tile: Tile
  descriptor: ViewDescriptor<T>
  records: T[]
  recordTotal: number | undefined
}) {
  switch (tile.type) {
    case 'stat':
      return <StatWidgetBody tile={tile} records={records} recordTotal={recordTotal} />
    case 'xy':
      return <XyWidgetBody tile={tile} records={records} recordTotal={recordTotal} />
    case 'pie':
      return <PieWidgetBody tile={tile} records={records} recordTotal={recordTotal} />
    case 'list':
      return <ListWidgetBody tile={tile} descriptor={descriptor} />
  }
}
