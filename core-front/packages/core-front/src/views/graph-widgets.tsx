'use client'
import { useEffect, useRef, useState, type RefObject } from 'react'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { DataGrid, type GridColDef } from '@mui/x-data-grid'
import type { Tile } from '../api/graph'
import { useRelationOps, type RelationRecord } from './relation-ops'
import {
  OTHER_LABEL,
  niceTicks,
  pieSlices,
  statValue,
  xySeries,
  type BarMode,
  type BucketGranularity,
  type FullAggregate,
  type NumericAggregate,
  type PieSlice,
  type XySeries,
} from './graph-aggregate'
import { fieldLabel, type ViewDescriptor } from './descriptor'
import { useNumberFormat } from './format-store'
import { useI18nStore } from '../i18n/i18n-store'
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

/**
 * Tracks a ref'd element's OWN rendered pixel size (ResizeObserver), so a
 * chart's SVG can be sized 1:1 to its real container instead of a fixed
 * literal — the fix for "resize the tile and the chart stays the same size."
 * Starts at `fallback` (a sane default, never 0×0) and stays there until the
 * first real measurement arrives — jsdom's ResizeObserver stub (this repo's
 * test setup) never actually fires, so component tests render at `fallback`
 * forever, which is fine: real responsiveness is a real-browser concern (see
 * the roadmap's testing-strategy notes on this same tradeoff for RGL). The
 * caller must render the ref'd element UNCONDITIONALLY from the first render
 * (never behind an early return): the observer attaches once, on mount, to
 * whatever `ref.current` is at that moment — if that's still null because
 * the element only appears on a later render, it never retries (the exact
 * bug graph-renderer.tsx's own container hit earlier in this effort).
 */
function useElementSize<T extends HTMLElement>(
  fallback: { width: number; height: number },
): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null)
  const [size, setSize] = useState(fallback)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, size]
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

/** Centered within whatever space is available — every widget's "nothing to
 * show" state renders the same way, regardless of how large the tile is. */
function NoData() {
  const t = useT()
  return (
    <Box sx={{ height: '100%', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Typography variant="caption" color="text.secondary">
        {t('No data')}
      </Typography>
    </Box>
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
    <Stack spacing={0.25} sx={{ height: '100%', width: '100%' }}>
      <PartialDataBadge shown={records.length} total={recordTotal} />
      {/* Centered, not pinned to the top-left — a big resized tile shouldn't
          leave the number stranded in one corner. */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
        }}
      >
        <Typography variant="caption" color="text.secondary">
          {t(AGGREGATE_LABELS[config.aggregate])}
        </Typography>
        <Typography variant="h3" sx={{ fontVariantNumeric: 'tabular-nums' }}>
          {format(value, { decimals: 2 })}
        </Typography>
      </Box>
    </Stack>
  )
}

// ── xy (line chart — one series, or one per distinct value of a "series"
// field, e.g. a status column: docs/roadmaps/list-view-modes.md's Phase 5.1
// multi-series upgrade). Axis gridlines/labels + a legend (multi-series only)
// + smoothed lines, sized 1:1 to the tile's OWN measured pixels via
// useElementSize — never a fixed literal, so resizing the tile visibly
// resizes the chart instead of leaving it stranded at its original size. ──

/** 'YYYY-MM' or 'YYYY-MM-DD' bucket key → a short localized label ("août 25"
 * for a month bucket, "10 août" for a day/week bucket) — never re-parsed via
 * `new Date('YYYY-MM-DD')` (UTC-midnight parsing, the classic wrong-local-day
 * bug this codebase's Calendar renderer already avoids); built from the
 * numeric constructor throughout, same discipline as `bucketKey` itself. */
function formatBucketLabel(bucket: string, granularity: BucketGranularity, locale: string | undefined): string {
  const parts = bucket.split('-').map(Number)
  if (granularity === 'month') {
    const [y, m] = parts as [number, number]
    return new Intl.DateTimeFormat(locale, { month: 'short', year: '2-digit' }).format(new Date(y, m - 1, 1))
  }
  const [y, m, d] = parts as [number, number, number]
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(new Date(y, m - 1, d))
}

/** A smooth (not straight-segment) path through `coords`, via a cubic Bézier
 * per segment with horizontally-offset control points — a standard, simple
 * "smooth line" construction (no full spline library needed) that reads as a
 * curve without ever overshooting a data point's own y value. */
function smoothPath(coords: { x: number; y: number }[]): string {
  if (coords.length === 0) return ''
  if (coords.length === 1) return `M ${coords[0]!.x},${coords[0]!.y}`
  let d = `M ${coords[0]!.x},${coords[0]!.y}`
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[i]!
    const p1 = coords[i + 1]!
    const dx = (p1.x - p0.x) / 2
    d += ` C ${p0.x + dx},${p0.y} ${p1.x - dx},${p1.y} ${p1.x},${p1.y}`
  }
  return d
}

const AXIS_PADDING = { top: 10, right: 12, bottom: 22, left: 34 }

function XyChart({
  series,
  bucket,
  format,
}: {
  series: XySeries[]
  bucket: BucketGranularity
  format: (v: number) => string
}) {
  const t = useT()
  const palette = useGraphPalette()
  const locale = useI18nStore((s) => s.locale) ?? undefined
  const [chartRef, { width, height }] = useElementSize<HTMLDivElement>({ width: 260, height: 120 })

  const hasData = series.some((s) => s.points.length > 0)
  const showLegend = series.length > 1 && hasData

  // Shared X domain: every bucket that appears in ANY series, chronologically
  // (bucket keys are 'YYYY-MM[-DD]', which sorts correctly as plain text).
  const buckets = Array.from(new Set(series.flatMap((s) => s.points.map((p) => p.bucket)))).sort()
  const allValues = series.flatMap((s) => s.points.map((p) => p.value))
  const maxValue = Math.max(0, ...allValues)
  const ticks = niceTicks(maxValue)
  const domainMax = ticks[ticks.length - 1] || 1

  const legendHeight = showLegend ? 22 : 0
  const innerW = Math.max(1, width - AXIS_PADDING.left - AXIS_PADDING.right)
  const innerH = Math.max(1, height - legendHeight - AXIS_PADDING.top - AXIS_PADDING.bottom)
  const xForIndex = (i: number) =>
    AXIS_PADDING.left + (buckets.length > 1 ? (i * innerW) / (buckets.length - 1) : innerW / 2)
  const yForValue = (v: number) => AXIS_PADDING.top + innerH - (v / domainMax) * innerH

  const bucketIndex = new Map(buckets.map((b, i) => [b, i]))

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', minHeight: 0 }}>
      <Box ref={chartRef} sx={{ flex: 1, minHeight: 0, width: '100%' }}>
        {!hasData ? (
          <NoData />
        ) : (
          <svg width={width} height={height} role="img" aria-label={t('Line chart')}>
            {/* Y-axis gridlines + numeric labels. */}
            {ticks.map((tick) => {
              const y = yForValue(tick)
              return (
                <g key={tick}>
                  <line
                    x1={AXIS_PADDING.left}
                    y1={y}
                    x2={width - AXIS_PADDING.right}
                    y2={y}
                    stroke={palette.chrome.baseline}
                    strokeWidth={1}
                    opacity={tick === 0 ? 1 : 0.5}
                  />
                  <text x={AXIS_PADDING.left - 8} y={y} textAnchor="end" dominantBaseline="middle" fontSize={10} fill={palette.chrome.mutedInk}>
                    {format(tick)}
                  </text>
                </g>
              )
            })}
            {/* X-axis bucket labels. */}
            {buckets.map((bucketKeyValue, i) => (
              <text
                key={bucketKeyValue}
                x={xForIndex(i)}
                y={height - legendHeight - 6}
                textAnchor="middle"
                fontSize={10}
                fill={palette.chrome.mutedInk}
              >
                {formatBucketLabel(bucketKeyValue, bucket, locale)}
              </text>
            ))}
            {/* One smoothed line + point markers per series. */}
            {series.map((s, seriesIndex) => {
              if (s.points.length === 0) return null
              const color = colorFor(seriesIndex, palette.categorical)
              const coords = s.points.map((p) => ({
                x: xForIndex(bucketIndex.get(p.bucket)!),
                y: yForValue(p.value),
                point: p,
              }))
              return (
                <g key={s.label || seriesIndex}>
                  <path d={smoothPath(coords)} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />
                  {coords.map((c) => (
                    <circle key={c.point.bucket} cx={c.x} cy={c.y} r={3.5} fill={color}>
                      <title>{`${s.label ? `${s.label} — ` : ''}${c.point.bucket}: ${format(c.point.value)}`}</title>
                    </circle>
                  ))}
                </g>
              )
            })}
          </svg>
        )}
      </Box>
      {showLegend ? (
        <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', px: `${AXIS_PADDING.left}px`, minHeight: legendHeight }}>
          {series.map((s, i) => (
            <Stack key={s.label} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
              <Box
                sx={{
                  width: 10,
                  height: 2,
                  borderRadius: '1px',
                  flexShrink: 0,
                  bgcolor: colorFor(i, palette.categorical),
                }}
              />
              <Typography variant="caption" noWrap color="text.secondary">
                {s.label}
              </Typography>
            </Stack>
          ))}
        </Stack>
      ) : null}
    </Box>
  )
}

// ── bar (grouped or stacked — one bar per bucket, or one segment per series
// stacked within it) reuses xySeries()/niceTicks() exactly like XyChart, just
// rendering <rect> bars instead of a smoothed line. ─────────────────────────

function BarChart({
  series,
  bucket,
  mode,
  format,
}: {
  series: XySeries[]
  bucket: BucketGranularity
  mode: BarMode
  format: (v: number) => string
}) {
  const t = useT()
  const palette = useGraphPalette()
  const locale = useI18nStore((s) => s.locale) ?? undefined
  const [chartRef, { width, height }] = useElementSize<HTMLDivElement>({ width: 260, height: 120 })

  const hasData = series.some((s) => s.points.length > 0)
  const showLegend = series.length > 1 && hasData

  const buckets = Array.from(new Set(series.flatMap((s) => s.points.map((p) => p.bucket)))).sort()
  const valueByBucket = new Map(
    buckets.map((b) => [b, series.map((s) => s.points.find((p) => p.bucket === b)?.value ?? 0)]),
  )

  const maxValue =
    mode === 'stacked'
      ? Math.max(0, ...buckets.map((b) => valueByBucket.get(b)!.reduce((sum, v) => sum + v, 0)))
      : Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.value)))
  const ticks = niceTicks(maxValue)
  const domainMax = ticks[ticks.length - 1] || 1

  const legendHeight = showLegend ? 22 : 0
  const innerW = Math.max(1, width - AXIS_PADDING.left - AXIS_PADDING.right)
  const innerH = Math.max(1, height - legendHeight - AXIS_PADDING.top - AXIS_PADDING.bottom)

  const groupWidth = buckets.length > 0 ? innerW / buckets.length : innerW
  const groupPadding = groupWidth * 0.15
  const usableGroupWidth = Math.max(1, groupWidth - groupPadding * 2)
  const barGap = mode === 'grouped' && series.length > 1 ? 2 : 0
  const barWidth =
    mode === 'grouped'
      ? Math.max(1, (usableGroupWidth - barGap * (series.length - 1)) / Math.max(1, series.length))
      : usableGroupWidth

  const xForGroup = (i: number) => AXIS_PADDING.left + i * groupWidth + groupPadding
  const yForValue = (v: number) => AXIS_PADDING.top + innerH - (v / domainMax) * innerH

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', minHeight: 0 }}>
      <Box ref={chartRef} sx={{ flex: 1, minHeight: 0, width: '100%' }}>
        {!hasData ? (
          <NoData />
        ) : (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={t(mode === 'stacked' ? 'Stacked bar chart' : 'Bar chart')}
          >
            {/* Y-axis gridlines + numeric labels. */}
            {ticks.map((tick) => {
              const y = yForValue(tick)
              return (
                <g key={tick}>
                  <line
                    x1={AXIS_PADDING.left}
                    y1={y}
                    x2={width - AXIS_PADDING.right}
                    y2={y}
                    stroke={palette.chrome.baseline}
                    strokeWidth={1}
                    opacity={tick === 0 ? 1 : 0.5}
                  />
                  <text x={AXIS_PADDING.left - 8} y={y} textAnchor="end" dominantBaseline="middle" fontSize={10} fill={palette.chrome.mutedInk}>
                    {format(tick)}
                  </text>
                </g>
              )
            })}
            {/* X-axis bucket labels. */}
            {buckets.map((bucketKeyValue, i) => (
              <text
                key={bucketKeyValue}
                x={AXIS_PADDING.left + i * groupWidth + groupWidth / 2}
                y={height - legendHeight - 6}
                textAnchor="middle"
                fontSize={10}
                fill={palette.chrome.mutedInk}
              >
                {formatBucketLabel(bucketKeyValue, bucket, locale)}
              </text>
            ))}
            {/* One bar per series per bucket — side-by-side (grouped) or
                stacked segments (stacked). */}
            {buckets.map((bucketKeyValue, bucketIndex) => {
              const values = valueByBucket.get(bucketKeyValue)!
              if (mode === 'stacked') {
                let stackTop = 0
                return (
                  <g key={bucketKeyValue}>
                    {values.map((v, seriesIndex) => {
                      const yTop = yForValue(stackTop + v)
                      const yBottom = yForValue(stackTop)
                      stackTop += v
                      if (v === 0) return null
                      const color = colorFor(seriesIndex, palette.categorical)
                      return (
                        <rect
                          key={series[seriesIndex]!.label || seriesIndex}
                          x={xForGroup(bucketIndex)}
                          y={yTop}
                          width={barWidth}
                          height={Math.max(0, yBottom - yTop)}
                          fill={color}
                        >
                          <title>{`${series[seriesIndex]!.label ? `${series[seriesIndex]!.label} — ` : ''}${bucketKeyValue}: ${format(v)}`}</title>
                        </rect>
                      )
                    })}
                  </g>
                )
              }
              return (
                <g key={bucketKeyValue}>
                  {values.map((v, seriesIndex) => {
                    if (v === 0) return null
                    const x = xForGroup(bucketIndex) + seriesIndex * (barWidth + barGap)
                    const y = yForValue(v)
                    const color = colorFor(seriesIndex, palette.categorical)
                    return (
                      <rect
                        key={series[seriesIndex]!.label || seriesIndex}
                        x={x}
                        y={y}
                        width={barWidth}
                        height={Math.max(0, innerH - (y - AXIS_PADDING.top))}
                        fill={color}
                      >
                        <title>{`${series[seriesIndex]!.label ? `${series[seriesIndex]!.label} — ` : ''}${bucketKeyValue}: ${format(v)}`}</title>
                      </rect>
                    )
                  })}
                </g>
              )
            })}
          </svg>
        )}
      </Box>
      {showLegend ? (
        <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', px: `${AXIS_PADDING.left}px`, minHeight: legendHeight }}>
          {series.map((s, i) => (
            <Stack key={s.label} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
              <Box
                sx={{
                  width: 10,
                  height: 10,
                  borderRadius: '2px',
                  flexShrink: 0,
                  bgcolor: colorFor(i, palette.categorical),
                }}
              />
              <Typography variant="caption" noWrap color="text.secondary">
                {s.label}
              </Typography>
            </Stack>
          ))}
        </Stack>
      ) : null}
    </Box>
  )
}

export function BarWidgetBody<T extends HasId>({
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
    seriesField?: string
    mode?: BarMode
    aggregate?: NumericAggregate
    bucket?: BucketGranularity
  }
  if (!config.xField || !config.yField || !config.aggregate || !config.bucket) return <NoData />
  const series = xySeries(records, {
    xField: config.xField,
    yField: config.yField,
    seriesField: config.seriesField,
    aggregate: config.aggregate,
    bucket: config.bucket,
  })
  return (
    <Stack spacing={0.5} sx={{ height: '100%', width: '100%' }}>
      <PartialDataBadge shown={records.length} total={recordTotal} />
      <Box sx={{ flex: 1, minHeight: 0, width: '100%' }}>
        <BarChart series={series} bucket={config.bucket} mode={config.mode ?? 'grouped'} format={(v) => format(v, { decimals: 1 })} />
      </Box>
    </Stack>
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
    seriesField?: string
    aggregate?: NumericAggregate
    bucket?: BucketGranularity
  }
  if (!config.xField || !config.yField || !config.aggregate || !config.bucket) return <NoData />
  const series = xySeries(records, {
    xField: config.xField,
    yField: config.yField,
    seriesField: config.seriesField,
    aggregate: config.aggregate,
    bucket: config.bucket,
  })
  return (
    <Stack spacing={0.5} sx={{ height: '100%', width: '100%' }}>
      <PartialDataBadge shown={records.length} total={recordTotal} />
      <Box sx={{ flex: 1, minHeight: 0, width: '100%' }}>
        <XyChart series={series} bucket={config.bucket} format={(v) => format(v, { decimals: 1 })} />
      </Box>
    </Stack>
  )
}

// ── pie (donut, categorical hues in fixed order + a legend) — slices are
// ALWAYS sized by record count per group (equal groups render as equal
// slices); an optional valueField only annotates the tooltip, it never skews
// slice size (docs/roadmaps/list-view-modes.md's Phase 5.2 fix). ──────────

function PieChart({ slices, format }: { slices: PieSlice[]; format: (v: number) => string }) {
  const t = useT()
  const palette = useGraphPalette()
  const [containerRef, { width, height }] = useElementSize<HTMLDivElement>({ width: 200, height: 84 })
  const total = slices.reduce((sum, s) => sum + s.count, 0)

  // The donut scales with whichever dimension is tighter (a short-wide tile
  // is height-bound, a narrow-tall one is width-bound) — never a fixed
  // literal, so resizing the tile visibly resizes the chart. Stroke width
  // stays proportional (≈24% of the diameter) so a bigger donut doesn't read
  // as a thin ring and a smaller one doesn't read as a solid disk.
  const size = Math.max(32, Math.min(height, width * 0.55))
  const strokeWidth = size * 0.24
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  let offset = 0

  return (
    <Box
      ref={containerRef}
      sx={{ height: '100%', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      {total <= 0 ? (
        <NoData />
      ) : (
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', minWidth: 0, maxWidth: '100%' }}>
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
                const length = (slice.count / total) * circumference
                const dashoffset = -offset
                offset += length
                const color =
                  slice.label === OTHER_LABEL ? palette.chrome.mutedInk : colorFor(i, palette.categorical)
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
                    <title>{`${slice.label === OTHER_LABEL ? t('Other') : slice.label}: ${format(slice.displayValue)}`}</title>
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
        </Stack>
      )}
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
  const config = tile.config as { groupByField?: string; valueField?: string }
  if (!config.groupByField) return <NoData />
  const slices = pieSlices(records, { groupByField: config.groupByField, valueField: config.valueField })
  return (
    <Stack spacing={0.5} sx={{ height: '100%', width: '100%' }}>
      <PartialDataBadge shown={records.length} total={recordTotal} />
      <Box sx={{ flex: 1, minHeight: 0, width: '100%' }}>
        <PieChart slices={slices} format={(v) => format(v, { decimals: config.valueField ? 1 : 0 })} />
      </Box>
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
    case 'bar':
      return <BarWidgetBody tile={tile} records={records} recordTotal={recordTotal} />
    case 'pie':
      return <PieWidgetBody tile={tile} records={records} recordTotal={recordTotal} />
    case 'list':
      return <ListWidgetBody tile={tile} descriptor={descriptor} />
  }
}
