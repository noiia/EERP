'use client'
import { useState } from 'react'
import Stack from '@mui/material/Stack'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import type { LineChartSeries } from '../charts/line-chart'
import { LineChart } from '../charts/line-chart'
import { useT } from '../../i18n/translate'
import type { MetricsIdealPoint, MetricsPoint } from './insights-renderer'

// Burndown tab (ADR-041): the remaining line (remaining_hours in Hours mode,
// scope_tasks − done_tasks in Tasks mode) plus the dashed ideal line — the
// endpoint's two burndown series, drawn by the shared LineChart.
export function BurnChart({ points, ideal }: { points: MetricsPoint[]; ideal: MetricsIdealPoint[] }) {
  const t = useT()
  const [mode, setMode] = useState<'hours' | 'tasks'>('hours')

  const series: LineChartSeries[] =
    mode === 'hours'
      ? [
          { key: 'remaining', label: t('Remaining hours'), points: points.map((p) => ({ x: p.date, y: p.remaining_hours })) },
          ...(ideal.length
            ? [{ key: 'ideal', label: t('Ideal'), points: ideal.map((p) => ({ x: p.date, y: p.remaining_hours })), dashed: true }]
            : []),
        ]
      : [{ key: 'remaining-tasks', label: t('Remaining tasks'), points: points.map((p) => ({ x: p.date, y: p.scope_tasks - p.done_tasks })) }]

  return (
    <Stack spacing={1.5}>
      <ToggleButtonGroup size="small" exclusive value={mode} onChange={(_e, v) => v && setMode(v)} aria-label={t('Burndown')}>
        <ToggleButton value="hours">{t('Hours')}</ToggleButton>
        <ToggleButton value="tasks">{t('Tasks')}</ToggleButton>
      </ToggleButtonGroup>
      <LineChart series={series} yLabel={mode === 'hours' ? t('Hours') : t('Tasks')} height={280} />
    </Stack>
  )
}
