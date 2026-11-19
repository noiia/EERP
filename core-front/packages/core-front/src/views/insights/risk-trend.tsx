'use client'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import { useI18nStore } from '../../i18n/i18n-store'
import { useT } from '../../i18n/translate'
import { useNumberFormat } from '../format-store'
import { niceRange } from '../graph-aggregate'
import { useGraphPalette } from '../graph-widgets'
import { dayLabel, PAD, VIEW_W } from '../charts/line-chart'
import type { MetricsRiskPoint } from './insights-renderer'

const HEIGHT = 280

// The stacked bands, bottom→top in the ADR-040 band order (low → high). Their
// colors are the theme's success/warning/error, so they match the risk matrix
// (and dark mode) exactly.
const BANDS = [
  { id: 'green', label: 'Green', tone: 'success' },
  { id: 'amber', label: 'Amber', tone: 'warning' },
  { id: 'red', label: 'Red', tone: 'error' },
] as const

/**
 * Risk trend tab (ADR-041): the stacked counts of the risks in each ADR-040
 * band (≤ 4 green, ≤ 12 amber, > 12 red) over time, plus the day's
 * max-criticity line on its own right-hand scale (criticity is a score, not a
 * count, so the line keeps its own axis instead of squashing the counts).
 */
export function RiskTrend({ risk }: { risk: MetricsRiskPoint[] }) {
  const t = useT()
  const th = useTheme()
  const palette = useGraphPalette()
  const { format } = useNumberFormat()
  const locale = useI18nStore((s) => s.locale) ?? undefined

  const xs = risk.map((p) => p.date)
  const totals = risk.map((p) => p.green + p.amber + p.red)
  const ticks = niceRange(0, Math.max(0, ...totals))
  const lo = ticks[0]!
  const hi = ticks.length > 1 ? ticks[ticks.length - 1]! : lo + 1

  const innerW = VIEW_W - PAD.left - PAD.right
  const plotBottom = HEIGHT - PAD.bottom
  const innerH = plotBottom - PAD.top
  const xFor = (i: number) => (xs.length > 1 ? PAD.left + (i * innerW) / (xs.length - 1) : PAD.left + innerW / 2)
  const yFor = (v: number) => plotBottom - ((v - lo) / (hi - lo)) * innerH
  const r = (v: number) => Math.round(v * 100) / 100
  const labelStep = Math.max(1, Math.ceil(xs.length / 8))

  const bandValue = (id: (typeof BANDS)[number]['id']) => risk.map((p) => p[id])
  const cum: number[][] = []
  BANDS.forEach((band, i) => {
    const values = bandValue(band.id)
    cum[i] = values.map((v, j) => v + (i > 0 ? cum[i - 1]![j]! : 0))
  })
  const bandArea = (i: number) => {
    const top = cum[i]!
    const bottom = i > 0 ? cum[i - 1]! : risk.map(() => lo)
    const forward = risk.map((_p, j) => `${j === 0 ? 'M' : 'L'} ${r(xFor(j))},${r(yFor(bottom[j]!))}`).join(' ')
    const back = risk.map((_p, j) => `L ${r(xFor(j))},${r(yFor(top[j]!))}`).reverse().join(' ')
    return `${forward} ${back} Z`
  }

  // The max-criticity line: its own scale (criticity, up to 24), the null
  // days (no live risk) are skipped.
  const maxCrit = Math.max(0, ...risk.map((p) => p.max_criticity ?? 0))
  const critTicks = niceRange(0, maxCrit)
  const critHi = critTicks.length > 1 ? critTicks[critTicks.length - 1]! : 1
  const yCrit = (v: number) => plotBottom - (v / critHi) * innerH
  const linePts = xs.map((_x, j) => (risk[j]!.max_criticity != null ? ([j, risk[j]!.max_criticity!] as const) : null)).filter((p): p is readonly [number, number] => p != null)
  const lineD = linePts.map(([j, v], i) => `${i === 0 ? 'M' : 'L'} ${r(xFor(j))},${r(yCrit(v))}`).join(' ')

  const tooltipAt = (j: number) => {
    const p = risk[j]!
    const crit = p.max_criticity != null ? `Max criticity: ${format(p.max_criticity)}, ` : ''
    return `${dayLabel(p.date, locale)} — ${crit}${BANDS.map((b) => `${t(b.label)}: ${format(p[b.id])}`).join(', ')}`
  }

  return (
    <Box sx={{ width: '100%' }}>
      <svg viewBox={`0 0 ${VIEW_W} ${HEIGHT}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label={t('Risk trend')}>
        {/* Left axis: the counts. */}
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
        {/* Right axis: the max-criticity score (the line's own scale) — the
            labels sit inside the plot's right edge (no room for an outside
            gutter at the shared right padding). */}
        {critTicks.map((tick) => (
          <text key={tick} x={VIEW_W - PAD.right - 2} y={yCrit(tick)} textAnchor="end" dominantBaseline="middle" fontSize={10} fill={palette.chrome.primaryInk} opacity={0.6}>
            {format(tick)}
          </text>
        ))}
        {/* x labels (thinned). */}
        {xs.map((x, i) =>
          i % labelStep === 0 || i === xs.length - 1 ? (
            <text key={x} x={xFor(i)} y={HEIGHT - 6} textAnchor="middle" fontSize={10} fill={palette.chrome.mutedInk}>
              {dayLabel(x, locale)}
            </text>
          ) : null,
        )}
        {/* Stacked band counts, low (green) at the bottom, high (red) on top. */}
        {BANDS.map((band, i) => (
          <path
            key={band.id}
            data-testid={`risk-band-${band.id}`}
            d={bandArea(i)}
            fill={th.palette[band.tone].main}
          />
        ))}
        {/* The max-criticity line. */}
        <path data-testid="risk-trend-max" d={lineD} fill="none" stroke={palette.chrome.primaryInk} strokeWidth={2} strokeLinecap="round" />
        {linePts.map(([j, v]) => (
          <circle key={xs[j]!} cx={xFor(j)} cy={yCrit(v)} r={3} fill={palette.chrome.primaryInk} />
        ))}
        {/* Per-date hit areas: the tooltip lists the day's counts. */}
        {xs.map((x, i) => {
          const colW = xs.length > 1 ? innerW / (xs.length - 1) : innerW
          const x0 = Math.max(PAD.left, xFor(i) - colW / 2)
          return (
            <Tooltip key={x} title={tooltipAt(i)} followCursor disableInteractive enterDelay={0} leaveDelay={0}>
              <rect data-rt-hit={x} x={x0} y={PAD.top} width={Math.min(colW, VIEW_W - PAD.right - x0)} height={Math.max(1, innerH)} fill="transparent" />
            </Tooltip>
          )
        })}
      </svg>
      <Stack data-testid="risk-legend" direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', px: `${PAD.left}px`, mt: 0.5 }}>
        {BANDS.map((band) => (
          <Stack key={band.id} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            <Box sx={{ width: 12, height: 2, borderRadius: '1px', flexShrink: 0, bgcolor: th.palette[band.tone].main }} />
            <Typography variant="caption" noWrap color="text.secondary">
              {t(band.label)}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  )
}
