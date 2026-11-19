'use client'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useI18nStore } from '../../i18n/i18n-store'
import { useT } from '../../i18n/translate'
import { useNumberFormat } from '../format-store'
import { niceRange } from '../graph-aggregate'
import { colorFor, useGraphPalette } from '../graph-widgets'
import { dayLabel, PAD, VIEW_W } from '../charts/line-chart'
import type { MetricsFlowPoint, MetricsStage } from './insights-renderer'

const HEIGHT = 280

// Stack order: the closed stages hold the tasks that left the flow, so they
// settle at the bottom of the stack; the open stages go above them, both
// groups in `sequence` order.
function stackOrder(stages: MetricsStage[]): MetricsStage[] {
  const bySeq = (a: MetricsStage, b: MetricsStage) => a.sequence - b.sequence
  return [...stages.filter((s) => s.closed).sort(bySeq), ...stages.filter((s) => !s.closed).sort(bySeq)]
}

/**
 * Flow tab (ADR-041): where the project's tasks were, per stage, over time.
 * One stacked area per stage on a shared date axis (plain SVG, the same
 * fixed-viewBox scaling as the LineChart), the categorical palette, and a
 * hover/tap tooltip listing the counts at the pointer's date.
 */
export function FlowChart({ stages, flow }: { stages: MetricsStage[]; flow: MetricsFlowPoint[] }) {
  const t = useT()
  const palette = useGraphPalette()
  const { format } = useNumberFormat()
  const locale = useI18nStore((s) => s.locale) ?? undefined

  const ordered = stackOrder(stages)
  const xs = flow.map((p) => p.date)
  const totals = flow.map((p) => ordered.reduce((sum, st) => sum + (p.counts[st.id] ?? 0), 0))
  const ticks = niceRange(0, Math.max(0, ...totals))
  const lo = ticks[0]!
  const hi = ticks.length > 1 ? ticks[ticks.length - 1]! : lo + 1

  const innerW = VIEW_W - PAD.left - PAD.right
  const plotBottom = HEIGHT - PAD.bottom
  const innerH = plotBottom - PAD.top
  const xFor = (i: number) => (xs.length > 1 ? PAD.left + (i * innerW) / (xs.length - 1) : PAD.left + innerW / 2)
  const yFor = (v: number) => plotBottom - ((v - lo) / (hi - lo)) * innerH
  // Rounded to 2 decimals: the stacked edges land on clean numbers (the plot
  // baseline stays exactly at `plotBottom`).
  const r = (v: number) => Math.round(v * 100) / 100
  const labelStep = Math.max(1, Math.ceil(xs.length / 8))

  // Cumulative counts, stack bottom→top: cum[i][j] = total of stages 0..i at date j.
  const cum: number[][] = []
  ordered.forEach((st, i) => {
    cum[i] = flow.map((p, j) => (p.counts[st.id] ?? 0) + (i > 0 ? cum[i - 1]![j]! : 0))
  })
  const area = (i: number) => {
    const top = cum[i]!
    const bottom = i > 0 ? cum[i - 1]! : flow.map(() => lo)
    const forward = flow.map((_p, j) => `${j === 0 ? 'M' : 'L'} ${r(xFor(j))},${r(yFor(bottom[j]!))}`).join(' ')
    const back = flow.map((_p, j) => `L ${r(xFor(j))},${r(yFor(top[j]!))}`).reverse().join(' ')
    return `${forward} ${back} Z`
  }
  const tooltipAt = (j: number) =>
    `${dayLabel(xs[j]!, locale)} — ${ordered.map((st) => `${st.name}: ${format(flow[j]!.counts[st.id] ?? 0)}`).join(', ')}`

  return (
    <Box sx={{ width: '100%' }}>
      <svg viewBox={`0 0 ${VIEW_W} ${HEIGHT}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label={t('Flow')}>
        {/* y-label + y gridlines (niceRange, zero at the baseline). */}
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
            <text key={x} x={xFor(i)} y={HEIGHT - 6} textAnchor="middle" fontSize={10} fill={palette.chrome.mutedInk}>
              {dayLabel(x, locale)}
            </text>
          ) : null,
        )}
        {/* One stacked area per stage, bottom (closed) to top. */}
        {ordered.map((st, i) => (
          <path key={st.id} data-testid={`flow-area-${st.id}`} d={area(i)} fill={colorFor(i, palette.categorical)} />
        ))}
        {/* Per-date hit areas (the pointer's nearest x): the tooltip lists
            every stage's count at that date. */}
        {xs.map((x, i) => {
          const colW = xs.length > 1 ? innerW / (xs.length - 1) : innerW
          const x0 = Math.max(PAD.left, xFor(i) - colW / 2)
          return (
            <Tooltip key={x} title={tooltipAt(i)} followCursor disableInteractive enterDelay={0} leaveDelay={0}>
              <rect data-fc-hit={x} x={x0} y={PAD.top} width={Math.min(colW, VIEW_W - PAD.right - x0)} height={Math.max(1, innerH)} fill="transparent" />
            </Tooltip>
          )
        })}
      </svg>
      <Stack data-testid="flow-legend" direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', px: `${PAD.left}px`, mt: 0.5 }}>
        {ordered.map((st, i) => (
          <Stack key={st.id} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <Box sx={{ width: 12, height: 2, borderRadius: '1px', flexShrink: 0, bgcolor: colorFor(i, palette.categorical) }} />
            <Typography variant="caption" noWrap color="text.secondary">
              {st.name}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  )
}
