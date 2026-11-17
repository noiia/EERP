'use client'
import { useRouter } from 'next/navigation'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import LinearProgress from '@mui/material/LinearProgress'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useTheme } from '@mui/material/styles'
import { useI18nStore } from '../../i18n/i18n-store'
import { useT } from '../../i18n/translate'
import { erpPath } from '../../navigation'
import { useNumberFormat } from '../format-store'
import { usePhone } from '../use-phone'
import { useGraphPalette } from '../graph-widgets'
import { dayLabel, VIEW_W } from '../charts/line-chart'

// A `project_milestone` row as the roadmap reads it (the trigger-maintained
// aggregates included: `task_count` / `task_done_count`, `reached`).
export interface Milestone {
  id: string
  name: string
  deadline: string
  reached: boolean
  reached_at: string | null
  task_count: number
  task_done_count: number
}

const dateOnly = (iso: string) => iso.slice(0, 10)
const TRACK_Y = 14
const TRACK_PAD = 10

/** The local today as `YYYY-MM-DD` (from the numeric date parts — never a
 * UTC-midnight parse). */
function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Milestones tab (ADR-041): one row per milestone on a shared time axis — a
 * deadline diamond, the `reached_at` check, the task progress bar
 * (`task_done_count / task_count`), and a `Late` chip (error color) when the
 * milestone is unreached and past its deadline. A row tap opens the
 * milestone's form; on phone the label stacks over the bar.
 */
export function MilestoneRoadmap({ milestones, capped }: { milestones: Milestone[]; capped: boolean }) {
  const t = useT()
  const th = useTheme()
  const phone = usePhone()
  const { format } = useNumberFormat()
  const palette = useGraphPalette()
  const locale = useI18nStore((s) => s.locale) ?? undefined
  const router = useRouter()

  const open = (id: string) => router.push(erpPath(`/project/milestones/${id}`))
  const isLate = (m: Milestone) => !m.reached && dateOnly(m.deadline) < todayStr()

  // The shared time axis: min→max over every deadline and reached_at. ISO
  // dates are text-sortable, so min/max are plain string comparisons
  // (Math.min would coerce to Number and return NaN).
  const dates = milestones.flatMap((m) => [dateOnly(m.deadline), ...(m.reached_at ? [dateOnly(m.reached_at)] : [])])
  const minDate = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : ''
  const maxDate = dates.length ? dates.reduce((a, b) => (a > b ? b : a)) : ''
  const minMs = minDate ? Date.parse(minDate + 'T00:00:00Z') : 0
  const maxMs = maxDate ? Date.parse(maxDate + 'T00:00:00Z') : 0
  const xFor = (iso: string) => {
    const frac = maxMs > minMs ? (Date.parse(dateOnly(iso) + 'T00:00:00Z') - minMs) / (maxMs - minMs) : 0.5
    return TRACK_PAD + frac * (VIEW_W - 2 * TRACK_PAD)
  }
  // A few date labels across the axis (ISO dates are text-sortable).
  const axisDates =
    dates.length === 0
      ? []
      : Array.from({ length: 4 }, (_, i) => {
          const ms = minMs + (maxMs > minMs ? (i * (maxMs - minMs)) / 3 : 0)
          return new Date(ms).toISOString().slice(0, 10)
        })
  const diamond = (x: number) => `${x - 5},${TRACK_Y} ${x},${TRACK_Y - 5} ${x + 5},${TRACK_Y} ${x},${TRACK_Y + 5}`
  const check = (x: number) => `M ${x - 5},${TRACK_Y + 1} L ${x - 1},${TRACK_Y + 5} L ${x + 5},${TRACK_Y - 4}`

  return (
    <Stack spacing={0.5}>
      {/* The shared time axis (aligned with the rows' tracks). */}
      <Stack direction={phone ? 'column' : 'row'} sx={{ alignItems: 'center' }} data-testid="milestone-axis">
        {!phone && <Box sx={{ width: 200, flexShrink: 0 }} />}
        <svg viewBox={`0 0 ${VIEW_W} 26`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label={t('Milestones')}>
          <line x1={TRACK_PAD} y1={TRACK_Y} x2={VIEW_W - TRACK_PAD} y2={TRACK_Y} stroke={palette.chrome.baseline} strokeWidth={1} />
          {axisDates.map((d, i) => (
            <text
              key={i}
              x={TRACK_PAD + (i / 3) * (VIEW_W - 2 * TRACK_PAD)}
              y={24}
              textAnchor="middle"
              fontSize={10}
              fill={palette.chrome.mutedInk}
            >
              {dayLabel(d, locale)}
            </text>
          ))}
        </svg>
      </Stack>
      {milestones.map((m) => (
        <Stack
          key={m.id}
          component="button"
          type="button"
          data-testid={`milestone-row-${m.id}`}
          direction={phone ? 'column' : 'row'}
          spacing={1.5}
          sx={{
            alignItems: phone ? 'stretch' : 'center',
            width: '100%',
            textAlign: 'left',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            borderRadius: 1,
            p: 0.5,
          }}
          onClick={() => open(m.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') open(m.id)
          }}
          tabIndex={0}
          aria-label={`${m.name}: ${format(m.task_done_count)}/${format(m.task_count)}`}
        >
          <Stack
            data-testid={`milestone-label-${m.id}`}
            direction="row"
            spacing={1}
            sx={{ width: phone ? 'auto' : 200, flexShrink: 0, alignItems: 'center' }}
          >
            <Typography variant="body2" noWrap sx={{ flex: '1 1 auto', minWidth: 0 }}>
              {m.name}
            </Typography>
            {isLate(m) ? <Chip size="small" color="error" label={t('Late')} sx={{ flexShrink: 0 }} /> : null}
            <Typography variant="caption" sx={{ flexShrink: 0 }}>
              {format(m.task_done_count)}/{format(m.task_count)}
            </Typography>
          </Stack>
          <Stack spacing={0.5} sx={{ flex: '1 1 auto', minWidth: 0, width: '100%' }}>
            <LinearProgress
              variant="determinate"
              value={m.task_count > 0 ? (m.task_done_count / m.task_count) * 100 : 0}
              sx={{ height: 6, borderRadius: 3, flexShrink: 0 }}
            />
            <svg viewBox={`0 0 ${VIEW_W} 28`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label={t('Milestones')}>
              <line x1={TRACK_PAD} y1={TRACK_Y} x2={VIEW_W - TRACK_PAD} y2={TRACK_Y} stroke={palette.chrome.baseline} strokeWidth={1} opacity={0.5} />
              <polygon data-testid={`milestone-deadline-${m.id}`} points={diamond(xFor(m.deadline))} fill={palette.chrome.primaryInk} />
              {m.reached_at ? <path data-testid={`milestone-reached-${m.id}`} d={check(xFor(m.reached_at))} fill="none" stroke={th.palette.success.main} strokeWidth={2} strokeLinecap="round" /> : null}
            </svg>
          </Stack>
        </Stack>
      ))}
      {capped ? (
        <Typography variant="caption" color="text.secondary">
          {t('First 1000 shown')}
        </Typography>
      ) : null}
    </Stack>
  )
}
