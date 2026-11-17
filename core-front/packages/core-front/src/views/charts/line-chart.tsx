'use client'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useI18nStore } from '../../i18n/i18n-store'
import { useT } from '../../i18n/translate'
import { niceRange } from '../graph-aggregate'
import { colorFor, useGraphPalette } from '../graph-widgets'
import { useNumberFormat } from '../format-store'

/** One point of a time series: `x` is a `YYYY-MM-DD` date (text-sortable),
 * `y` the value. */
export interface LineChartPoint {
  x: string
  y: number
}

export interface LineChartSeries {
  key: string
  label: string
  points: LineChartPoint[]
  /** Dashed line (the ideal burndown line, e.g.). */
  dashed?: boolean
}

export interface LineChartProps {
  series: LineChartSeries[]
  /** The values' unit — the y-axis label ('Hours', 'Tasks', …). */
  yLabel: string
  /** The design plot height in px (the viewBox height; the SVG scales to its
   * container width, so the chart fills 390px phones and wide desktop alike). */
  height: number
}

// The chart draws once in a fixed viewBox and scales to `width: 100%`: the text
// shrinks/grows with the container instead of the chart being stranded at a
// fixed pixel width (the graph widgets measure their tile instead — here the
// container is the whole view, and the jsdom test viewport never fires a
// ResizeObserver, so a fixed viewBox is what a 390px test can assert).
// Exported so the Insights' sibling charts (views/insights/*) share the same
// geometry and date labels.
export const VIEW_W = 640
export const PAD = { top: 12, right: 14, bottom: 26, left: 40 }

/** `YYYY-MM-DD` → a short localized label ("11 Nov"), built from the numeric
 * Date constructor — never `new Date('YYYY-MM-DD')` (UTC-midnight parsing,
 * the classic wrong-local-day bug this codebase avoids throughout). */
export function dayLabel(x: string, locale: string | undefined): string {
  const [y, m, d] = x.split('-').map(Number)
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(new Date(y, m - 1, d))
}

/**
 * The Insights mode's shared line primitive (ADR-041): one plain-SVG chart,
 * axis + `niceRange` gridlines, one (optionally dashed) line per series, a
 * legend below the plot, and a hover/tap tooltip listing EVERY series at the
 * nearest date. Categorical palette from the graph widgets; no charting
 * library (plain SVG, per the dataviz guidance for ≤ ~5 lines).
 */
export function LineChart({ series, yLabel, height }: LineChartProps) {
  const t = useT()
  const palette = useGraphPalette()
  const { format } = useNumberFormat()
  const locale = useI18nStore((s) => s.locale) ?? undefined

  // Shared x domain: every date present in ANY series (dates sort as text).
  const xs = Array.from(new Set(series.flatMap((s) => s.points.map((p) => p.x)))).sort()
  const ys = series.flatMap((s) => s.points.map((p) => p.y))
  const ticks = niceRange(Math.min(0, ...ys), Math.max(0, ...ys))
  const lo = ticks[0]!
  const hi = ticks.length > 1 ? ticks[ticks.length - 1]! : lo + 1

  const innerW = VIEW_W - PAD.left - PAD.right
  const plotBottom = height - PAD.bottom
  const innerH = plotBottom - PAD.top
  const xFor = (i: number) => (xs.length > 1 ? PAD.left + (i * innerW) / (xs.length - 1) : PAD.left + innerW / 2)
  const yFor = (v: number) => plotBottom - ((v - lo) / (hi - lo)) * innerH
  const colW = xs.length > 1 ? innerW / (xs.length - 1) : innerW
  // Label every ~8th date (plus the last) so a 3-year window stays readable.
  const labelStep = Math.max(1, Math.ceil(xs.length / 8))

  const tooltipAt = (x: string): string => {
    const entries = series
      .map((s) => ({ s, p: s.points.find((pt) => pt.x === x) }))
      .filter((e): e is { s: LineChartSeries; p: LineChartPoint } => e.p != null)
    const list = entries.map((e) => `${e.s.label}: ${format(e.p.y)}`).join(', ')
    return list ? `${dayLabel(x, locale)} — ${list}` : dayLabel(x, locale)
  }

  const shown = series.filter((s) => s.points.length > 0)
  // The legend names the series even when one is drawn (e.g. the burndown's
  // Tasks mode: "Remaining tasks" is not the y-axis's "Tasks" unit), so the
  // reader never has to guess what a line is.
  const showLegend = shown.length >= 1

  return (
    <Box sx={{ width: '100%' }}>
      <svg viewBox={`0 0 ${VIEW_W} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label={t('Line chart')}>
        {/* y-label (rotated) + y gridlines with tick values (niceRange). */}
        <text
          x={10}
          y={(PAD.top + plotBottom) / 2}
          transform={`rotate(-90 10 ${(PAD.top + plotBottom) / 2})`}
          textAnchor="middle"
          fontSize={11}
          fill={palette.chrome.mutedInk}
        >
          {yLabel}
        </text>
        {ticks.map((tick) => {
          const y = yFor(tick)
          return (
            <g key={tick}>
              <line x1={PAD.left} y1={y} x2={VIEW_W - PAD.right} y2={y} stroke={palette.chrome.baseline} strokeWidth={1} opacity={tick === 0 ? 1 : 0.5} />
              <text x={PAD.left - 8} y={y} textAnchor="end" dominantBaseline="middle" fontSize={10} fill={palette.chrome.mutedInk}>
                {format(tick)}
              </text>
            </g>
          )
        })}
        {/* x labels (thinned). */}
        {xs.map((x, i) =>
          i % labelStep === 0 || i === xs.length - 1 ? (
            <text key={x} x={xFor(i)} y={height - 6} textAnchor="middle" fontSize={10} fill={palette.chrome.mutedInk}>
              {dayLabel(x, locale)}
            </text>
          ) : null,
        )}
        {/* One line (+ point markers) per series. */}
        {shown.map((s, si) => {
          const color = colorFor(si, palette.categorical)
          const line = s.points
            .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(xs.indexOf(p.x))},${yFor(p.y)}`)
            .join(' ')
          return (
            <g key={s.key}>
              <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeDasharray={s.dashed ? '5 4' : undefined} />
              {s.points.map((p) => (
                <circle key={p.x} cx={xFor(xs.indexOf(p.x))} cy={yFor(p.y)} r={3} fill={color} />
              ))}
            </g>
          )
        })}
        {/* Per-date hit areas: the pointer's nearest x. The tooltip lists every
            series present at that date (hover on mouse, tap on touch). */}
        {xs.map((x, i) => (
          <Tooltip
            key={x}
            title={tooltipAt(x)}
            followCursor
            disableInteractive
            enterDelay={0}
            leaveDelay={0}
          >
            <rect
              data-lc-hit={x}
              x={Math.max(PAD.left, xFor(i) - colW / 2)}
              y={PAD.top}
              width={Math.min(colW, VIEW_W - PAD.right - Math.max(PAD.left, xFor(i) - colW / 2))}
              height={Math.max(1, innerH)}
              fill="transparent"
            />
          </Tooltip>
        ))}
      </svg>
      {showLegend ? (
        <Stack data-testid="line-legend" direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', px: `${PAD.left}px`, mt: 0.5 }}>
          {shown.map((s, si) => (
            <Stack key={s.key} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
              <Box
                sx={{
                  width: 12,
                  height: s.dashed ? 0 : 2,
                  borderRadius: '1px',
                  flexShrink: 0,
                  borderBottom: s.dashed ? `2px dashed ${colorFor(si, palette.categorical)}` : undefined,
                  bgcolor: s.dashed ? 'transparent' : colorFor(si, palette.categorical),
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
