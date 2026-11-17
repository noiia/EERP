'use client'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import type { LineChartSeries } from '../charts/line-chart'
import { LineChart } from '../charts/line-chart'
import { useNumberFormat } from '../format-store'
import { useT } from '../../i18n/translate'
import type { MetricsPoint } from './insights-renderer'

// Earned value tab (ADR-041): the PV / EV / AC lines, the SPI / CPI chips at
// today (the workspace number format, `—` when the endpoint answered null on a
// zero denominator) and the pv_excluded caption.
export function EvmChart({
  points,
  spi,
  cpi,
  pvExcluded,
}: {
  points: MetricsPoint[]
  spi: number | null
  cpi: number | null
  pvExcluded: number
}) {
  const t = useT()
  const { format } = useNumberFormat()

  const chip = (abbrev: string, full: string, value: number | null) => (
    <Tooltip title={t(full)} enterDelay={0} disableInteractive>
      <Chip size="small" variant="outlined" label={`${abbrev} ${value == null ? '—' : format(value, { decimals: 2 })}`} />
    </Tooltip>
  )

  const series: LineChartSeries[] = [
    { key: 'pv', label: t('Planned value'), points: points.map((p) => ({ x: p.date, y: p.pv })) },
    { key: 'ev', label: t('Earned value'), points: points.map((p) => ({ x: p.date, y: p.ev })) },
    { key: 'ac', label: t('Actual cost'), points: points.map((p) => ({ x: p.date, y: p.ac })) },
  ]

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        {chip('SPI', 'Schedule performance index', spi)}
        {chip('CPI', 'Cost performance index', cpi)}
        {pvExcluded > 0 ? (
          <Typography variant="caption" color="text.secondary">
            {pvExcluded} {t('tasks without dates are left out of PV')}
          </Typography>
        ) : null}
      </Stack>
      <LineChart series={series} yLabel={t('Hours')} height={280} />
    </Stack>
  )
}
