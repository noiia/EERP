'use client'
import { useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import Stack from '@mui/material/Stack'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import Typography from '@mui/material/Typography'
import { serializeError, toApiError, type SerializedError } from '../../api/errors'
import type { InsightsConfig } from '../../api/view-fields'
import { useT } from '../../i18n/translate'
import { LineChart, type LineChartSeries } from '../charts/line-chart'
import { ErrorAlert } from '../error-alert'
import { usePhone } from '../use-phone'
import { useRelationOps } from '../relation-ops'
import { BurnChart } from './burn-chart'
import { EvmChart } from './evm-chart'
import { FlowChart } from './flow-chart'
import { MilestoneRoadmap, type Milestone } from './milestone-roadmap'
import { RiskTrend } from './risk-trend'

export interface InsightsRendererProps {
  config: InsightsConfig
  projectId: string
}

// The shape of GET /api/v1/project/:id/metrics (WP2, ADR-041): the analytics
// series the six tabs draw from. Hours/counts as JSON numbers, dates
// YYYY-MM-DD. The chart components read these types straight off the read.
export interface MetricsPoint {
  date: string
  scope_hours: number
  done_hours: number
  remaining_hours: number
  scope_tasks: number
  done_tasks: number
  pv: number
  ev: number
  ac: number
}

export interface MetricsIdealPoint {
  date: string
  remaining_hours: number
}

export interface MetricsStage {
  id: string
  name: string
  sequence: number
  closed: boolean
}

export interface MetricsFlowPoint {
  date: string
  counts: Record<string, number>
}

export interface MetricsRiskPoint {
  date: string
  max_criticity: number | null
  sum_criticity: number
  red: number
  amber: number
  green: number
}

export interface ProjectMetrics {
  from: string
  to: string
  bucket: 'day' | 'week'
  points: MetricsPoint[]
  ideal: MetricsIdealPoint[]
  spi: number | null
  cpi: number | null
  pv_excluded: number
  stages: MetricsStage[]
  flow: MetricsFlowPoint[]
  risk: MetricsRiskPoint[]
}

const TABS = ['burndown', 'burnup', 'earned', 'flow', 'milestones', 'risk'] as const
type TabKey = (typeof TABS)[number]
const TAB_LABEL: Record<TabKey, string> = {
  burndown: 'Burndown',
  burnup: 'Burnup',
  earned: 'Earned value',
  flow: 'Flow',
  milestones: 'Milestones',
  risk: 'Risk trend',
}

/** The read's all-zero case (Review Focus #2): a project with no dates, no
 * planned hours and no timesheets answers zeros with SPI/CPI null — the tabs
 * then say so instead of drawing an empty line (no NaN, no zero-division, no
 * empty SVG path). */
function pointsAreZero(points: MetricsPoint[]): boolean {
  return points.every(
    (p) =>
      p.scope_hours === 0 &&
      p.done_hours === 0 &&
      p.remaining_hours === 0 &&
      p.scope_tasks === 0 &&
      p.done_tasks === 0 &&
      p.pv === 0 &&
      p.ev === 0 &&
      p.ac === 0,
  )
}

function Empty() {
  const t = useT()
  return (
    <Box sx={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Typography variant="caption" color="text.secondary">
        {t('Not enough data yet')}
      </Typography>
    </Box>
  )
}

function Loading() {
  return (
    <Stack sx={{ alignItems: 'center', py: 4 }}>
      <CircularProgress size={20} />
    </Stack>
  )
}

// Burnup tab: the scope_hours and done_hours lines.
function BurnupChart({ points }: { points: MetricsPoint[] }) {
  const t = useT()
  const series: LineChartSeries[] = [
    { key: 'scope', label: t('Scope hours'), points: points.map((p) => ({ x: p.date, y: p.scope_hours })) },
    { key: 'done', label: t('Done hours'), points: points.map((p) => ({ x: p.date, y: p.done_hours })) },
  ]
  return <LineChart series={series} yLabel={t('Hours')} height={280} />
}

/**
 * Insights display mode of a project's task list (ADR-041): the burndown,
 * burnup, earned value, per-stage flow, milestone roadmap and risk trend of
 * the pinned project. ONE read per pinned id — `ops.get(projectEntity,
 * \`${id}/${metricsPath}\`)` — shared by every tab (the dispatch renders the
 * renderer `key={projectId}`, so a re-pin remounts and re-reads). The
 * selected tab is kept in the tab's session (`sessionStorage`,
 * `eerp.insights.tab.<projectEntity>`); the tabs scroll on phone.
 */
export function InsightsRenderer({ config, projectId }: InsightsRendererProps) {
  const t = useT()
  const ops = useRelationOps()
  const phone = usePhone()
  const tabKey = `eerp.insights.tab.${config.projectEntity}`
  const [tab, setTab] = useState<TabKey>(() => {
    const stored = typeof window !== 'undefined' ? window.sessionStorage.getItem(tabKey) : null
    return (TABS as readonly string[]).includes(stored ?? '') ? (stored as TabKey) : 'burndown'
  })
  const [metrics, setMetrics] = useState<ProjectMetrics | null>(null)
  const [error, setError] = useState<SerializedError | null>(null)
  // The milestones tab is the one tab that reads beyond the shared metrics
  // read: it pages the project's milestones until a short page (ADR-032).
  const [milestones, setMilestones] = useState<Milestone[] | null>(null)
  const [msCapped, setMsCapped] = useState(false)
  const [msError, setMsError] = useState<SerializedError | null>(null)

  const get = ops?.get
  const listPage = ops?.listPage
  // The ONE metrics read per pinned id: every tab draws from this single read.
  useEffect(() => {
    if (!get) return
    let cancelled = false
    get(config.projectEntity, `${projectId}/${config.metricsPath}`)
      .then((m) => {
        if (!cancelled) {
          setMetrics(m as unknown as ProjectMetrics)
          setError(null)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setMetrics(null)
          setError(serializeError(toApiError(e)))
        }
      })
    return () => {
      cancelled = true
    }
  }, [get, config.projectEntity, projectId, config.metricsPath])

  // Read the milestones only when the tab is shown: page until a short page,
  // stop at 1000 with a "first 1000 shown" caption (the Gantt/kanban pattern).
  useEffect(() => {
    if (tab !== 'milestones') {
      setMilestones(null)
      setMsCapped(false)
      setMsError(null)
      return
    }
    if (!listPage) {
      setMilestones([])
      setMsCapped(false)
      setMsError(null)
      return
    }
    let cancelled = false
    const PAGE_SIZE = 200
    const CAP = 1000
    const opts = { filter: { project_id: projectId }, order: 'deadline' }
    ;(async () => {
      const rows: Milestone[] = []
      let capped = false
      for (let page = 1; ; page++) {
        const res = await listPage(config.milestoneEntity, { ...opts, page, pageSize: PAGE_SIZE })
        rows.push(...(res.records as unknown as Milestone[]))
        if (res.records.length < PAGE_SIZE) break
        if (rows.length >= CAP) {
          // One probe row past the cap: exactly CAP matches isn't "more".
          const probe = await listPage(config.milestoneEntity, { ...opts, page: CAP + 1, pageSize: 1 })
          capped = probe.records.length > 0
          break
        }
      }
      if (!cancelled) {
        setMilestones(rows)
        setMsCapped(capped)
        setMsError(null)
      }
    })().catch((e: unknown) => {
      if (!cancelled) {
        setMilestones(null)
        setMsCapped(false)
        setMsError(serializeError(toApiError(e)))
      }
    })
    return () => {
      cancelled = true
    }
  }, [tab, listPage, config.milestoneEntity, projectId])

  const changeTab = (next: TabKey) => {
    setTab(next)
    try {
      window.sessionStorage.setItem(tabKey, next)
    } catch {
      // sessionStorage unavailable (private mode): the tab just isn't kept.
    }
  }

  const zero = metrics != null && pointsAreZero(metrics.points)

  return (
    <Box sx={{ p: 1 }}>
      <ErrorAlert error={error} />
      {/* Six tabs, scrollable on phone (they don't fit a 390px row). */}
      <Tabs
        value={tab}
        onChange={(_e, v: TabKey) => changeTab(v)}
        variant={phone ? 'scrollable' : 'standard'}
        scrollButtons="auto"
      >
        {TABS.map((k) => (
          <Tab key={k} value={k} label={t(TAB_LABEL[k])} />
        ))}
      </Tabs>
      <Box sx={{ pt: 2 }}>
        {tab === 'burndown' &&
          (metrics == null
            ? error
              ? null
              : <Loading />
            : zero && metrics.ideal.length === 0
              ? <Empty />
              : (
                  <BurnChart points={metrics.points} ideal={metrics.ideal} />
                ))}
        {tab === 'burnup' &&
          (metrics == null
            ? error
              ? null
              : <Loading />
            : zero
              ? <Empty />
              : (
                  <BurnupChart points={metrics.points} />
                ))}
        {tab === 'earned' &&
          (metrics == null
            ? error
              ? null
              : <Loading />
            : zero
              ? <Empty />
              : (
                  <EvmChart points={metrics.points} spi={metrics.spi} cpi={metrics.cpi} pvExcluded={metrics.pv_excluded} />
                ))}
        {tab === 'flow' &&
          (metrics == null
            ? error
              ? null
              : <Loading />
            : zero
              ? <Empty />
              : <FlowChart stages={metrics.stages} flow={metrics.flow} />)}
        {tab === 'milestones' &&
          (msError ? <ErrorAlert error={msError} /> : milestones == null ? <Loading /> : <MilestoneRoadmap milestones={milestones} capped={msCapped} />)}
        {tab === 'risk' &&
          (metrics == null
            ? error
              ? null
              : <Loading />
            : zero
              ? <Empty />
              : <RiskTrend risk={metrics.risk} />)}
      </Box>
    </Box>
  )
}
