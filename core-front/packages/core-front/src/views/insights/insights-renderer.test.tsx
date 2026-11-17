import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const push = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

import { InsightsRenderer } from './insights-renderer'
import { RelationOpsProvider, type RelationOps } from '../relation-ops'
import { ApiError } from '../../api/errors'
import { setViewportWidth } from '../../test/viewport'
import type { InsightsConfig } from '../../api/view-fields'

const config: InsightsConfig = {
  projectField: 'project_id',
  projectEntity: 'project',
  metricsPath: 'metrics',
  milestoneEntity: 'project_milestone',
}

const point = (date: string, o: Record<string, number> = {}) => ({
  date,
  scope_hours: 10,
  done_hours: 4,
  remaining_hours: 6,
  scope_tasks: 5,
  done_tasks: 2,
  pv: 8,
  ev: 4,
  ac: 3.6,
  ...o,
})

function metrics(o: Record<string, unknown> = {}) {
  return {
    from: '2026-11-01',
    to: '2026-11-30',
    bucket: 'day',
    points: [point('2026-11-16'), point('2026-11-17')],
    ideal: [
      { date: '2026-11-16', remaining_hours: 10 },
      { date: '2026-11-17', remaining_hours: 5 },
    ],
    spi: 0.85,
    cpi: 1.1,
    pv_excluded: 2,
    stages: [
      { id: 's1', name: 'New', sequence: 10, closed: false },
      { id: 's2', name: 'In progress', sequence: 20, closed: false },
      { id: 's3', name: 'Done', sequence: 30, closed: true },
    ],
    flow: [
      { date: '2026-11-16', counts: { s1: 2, s2: 1, s3: 1 } },
      { date: '2026-11-17', counts: { s1: 1, s2: 3, s3: 2 } },
    ],
    risk: [
      { date: '2026-11-16', max_criticity: 6, sum_criticity: 6, red: 0, amber: 1, green: 0 },
      { date: '2026-11-17', max_criticity: 18, sum_criticity: 18, red: 1, amber: 0, green: 0 },
    ],
    ...o,
  }
}

const MILESTONES = [
  {
    id: 'm1',
    name: 'Alpha',
    deadline: '2026-10-01T00:00:00Z',
    reached: true,
    reached_at: '2026-09-28T00:00:00Z',
    task_count: 2,
    task_done_count: 1,
  },
  { id: 'm2', name: 'Beta', deadline: '2026-11-01T00:00:00Z', reached: false, reached_at: null, task_count: 4, task_done_count: 1 },
]

function setup(body: unknown, o: { fail?: boolean; milestones?: unknown[] } = {}) {
  const get = vi.fn(async (entity: string, id: string) => {
    if (entity === 'project' && id === 'p1/metrics' && o.fail) throw new ApiError({ code: 'FORBIDDEN', message: 'nope', status: 403 })
    return body
  })
  const listPage = vi.fn(async (entity: string) =>
    entity === 'project_milestone'
      ? { records: o.milestones ?? MILESTONES, total: (o.milestones ?? MILESTONES).length }
      : { records: [], total: 0 },
  )
  const ops = { get, listPage } as unknown as RelationOps
  const utils = render(
    <RelationOpsProvider ops={ops}>
      <InsightsRenderer config={config} projectId="p1" />
    </RelationOpsProvider>,
  )
  return { ops, ...utils }
}

const TABS = ['Burndown', 'Burnup', 'Earned value', 'Flow', 'Milestones', 'Risk trend']

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.sessionStorage.clear()
})

describe('InsightsRenderer — burndown, burnup, earned value', () => {
  it('renders the six tabs', async () => {
    setup(metrics())
    for (const name of TABS) expect(await screen.findByRole('tab', { name })).toBeTruthy()
  })

  it('reads the metrics once through ops.get and shares the read over every tab', async () => {
    const { ops } = setup(metrics())
    await screen.findByRole('tab', { name: 'Burndown' })
    for (const name of TABS.slice(1)) fireEvent.click(screen.getByRole('tab', { name }))
    expect(ops.get).toHaveBeenCalledTimes(1)
    expect(ops.get).toHaveBeenCalledWith('project', 'p1/metrics')
  })

  it('draws the burndown remaining line with the dashed ideal', async () => {
    const { container } = setup(metrics())
    const burndown = await screen.findByRole('tab', { name: 'Burndown' })
    expect(burndown).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByText('Remaining hours')).toBeTruthy()
    expect(screen.getByText('Ideal')).toBeTruthy()
    expect(container.querySelector('path[stroke-dasharray]')).toBeTruthy()
  })

  it('switches the burndown to tasks with the Hours / Tasks toggle', async () => {
    setup(metrics())
    await screen.findByRole('tab', { name: 'Burndown' })
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }))
    expect(await screen.findByText('Remaining tasks')).toBeTruthy()
    expect(screen.queryByText('Remaining hours')).toBeNull()
  })

  it('draws the burnup scope and done hours', async () => {
    setup(metrics())
    fireEvent.click(await screen.findByRole('tab', { name: 'Burnup' }))
    expect(await screen.findByText('Scope hours')).toBeTruthy()
    expect(screen.getByText('Done hours')).toBeTruthy()
  })

  it('draws the earned value with the SPI and CPI chips', async () => {
    setup(metrics())
    fireEvent.click(await screen.findByRole('tab', { name: 'Earned value' }))
    expect(await screen.findByText('Planned value')).toBeTruthy()
    // 'Earned value' is both the tab and the EV series label.
    expect(screen.getAllByText('Earned value')).toHaveLength(2)
    expect(screen.getByText('Actual cost')).toBeTruthy()
    expect(screen.getByText('SPI 0.85')).toBeTruthy()
    expect(screen.getByText('CPI 1.10')).toBeTruthy()
  })

  it('shows a dash for a null SPI or CPI', async () => {
    setup(metrics({ spi: null, cpi: null }))
    fireEvent.click(await screen.findByRole('tab', { name: 'Earned value' }))
    expect(await screen.findByText('SPI —')).toBeTruthy()
    expect(screen.getByText('CPI —')).toBeTruthy()
  })

  it('names the tasks left out of PV', async () => {
    setup(metrics())
    fireEvent.click(await screen.findByRole('tab', { name: 'Earned value' }))
    expect(await screen.findByText('2 tasks without dates are left out of PV')).toBeTruthy()
  })

  it('hides the PV caption when nothing is excluded', async () => {
    setup(metrics({ pv_excluded: 0 }))
    fireEvent.click(await screen.findByRole('tab', { name: 'Earned value' }))
    await screen.findByText('Planned value')
    expect(screen.queryByText(/left out of PV/)).toBeNull()
  })

  it('shows Not enough data yet and no path for an all-zero project', async () => {
    const { container } = setup(
      metrics({
        points: [point('2026-11-17', { scope_hours: 0, done_hours: 0, remaining_hours: 0, scope_tasks: 0, done_tasks: 0, pv: 0, ev: 0, ac: 0 })],
        ideal: [],
        spi: null,
        cpi: null,
        stages: [],
        flow: [],
        risk: [],
      }),
    )
    expect(await screen.findByText('Not enough data yet')).toBeTruthy()
    expect(container.querySelector('path')).toBeNull()
  })

  it('shows the error alert when the read fails', async () => {
    setup(metrics(), { fail: true })
    expect(await screen.findByText(/nope/)).toBeTruthy()
  })

  it('keeps the selected tab in the tab session', async () => {
    setup(metrics())
    fireEvent.click(await screen.findByRole('tab', { name: 'Burnup' }))
    expect(window.sessionStorage.getItem('eerp.insights.tab.project')).toBe('burnup')
    cleanup()
    setup(metrics())
    const burnup = await screen.findByRole('tab', { name: 'Burnup' })
    expect(burnup).toHaveAttribute('aria-selected', 'true')
  })

  describe('phone', () => {
    it('scrolls the tabs and lets the chart fill the width at 390px', async () => {
      setViewportWidth(390)
      const { container } = setup(metrics())
      await screen.findByRole('tab', { name: 'Burndown' })
      // MUI v9 puts the scrollable marker on the scroller (MuiTabs-scrollableX).
      const scroller = screen.getByRole('tablist').closest('.MuiTabs-root')!.querySelector('.MuiTabs-scroller')!
      expect(scroller.className).toContain('MuiTabs-scrollableX')
      const svg = container.querySelector('svg')!
      expect(svg.style.width).toBe('100%')
      const legend = screen.getByTestId('line-legend')
      expect(svg.compareDocumentPosition(legend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(getComputedStyle(legend).flexWrap || legend.style.flexWrap).toBe('wrap')
    })
  })
})
