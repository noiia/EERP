import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CATEGORICAL_LIGHT, CHROME_LIGHT } from '@eerp/core-front'

// next/navigation: the page guard (notFound/redirect) plus the router push a
// bubble or row click performs.
const notFound = vi.fn(() => { throw new Error('NOT_FOUND') })
const redirect = vi.fn((url: string) => { throw new Error(`REDIRECT ${url}`) })
const pathnameMock = vi.fn(() => '/app/project/portfolio')
const routerPush = vi.fn()
vi.mock('next/navigation', () => ({
  notFound: () => notFound(),
  redirect: (u: string) => redirect(u),
  usePathname: () => pathnameMock(),
  useRouter: () => ({ push: (...a: unknown[]) => routerPush(...a), replace: vi.fn(), refresh: vi.fn(), prefetch: () => {}, back: vi.fn(), forward: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
const identity = vi.hoisted(() => ({
  userId: 'ada',
  tenantId: 't1',
  roles: [],
  permissions: ['project:project:read', 'project_task:project_task:read', 'project_risk:project_risk:read', 'users:users:read'],
}))
const requireAuth = vi.fn(async () => identity)
vi.mock('@/lib/session', () => ({ requireAuth: () => requireAuth() }))
const activeModules = vi.hoisted(() => ({ value: new Set(['project']) }))
vi.mock('@/lib/module-state', () => ({ activeModuleNames: async () => activeModules.value }))
// The relation-actions layer (projects, managers) and the server-side
// aggregates (done tasks, risk counts).
const listRecords = vi.fn()
const aggregateEntity = vi.fn()
vi.mock('@/lib/relation-actions', () => ({
  listRecords: (...a: unknown[]) => listRecords(...a),
  getRecord: vi.fn(),
}))
vi.mock('@/lib/graph-actions', () => ({
  aggregateEntity: (...a: unknown[]) => aggregateEntity(...a),
}))

import { Portfolio } from './Portfolio'
import PortfolioPage from '../../app/app/project/portfolio/page'

type Options = { filter?: Record<string, string>; order?: string; page?: number; pageSize?: number; in?: Record<string, string[]> }
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const dayOffset = (days: number) => {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return iso(d)
}
const project = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  manager_id: 'mgr',
  task_count: 0,
  planned_hours: 0,
  spent_hours: 0,
  date_end: null,
  ...over,
})
const group = (project_id: string, count: number) => ({ group: project_id, value: count, count })

function stubPortfolio(opts: {
  projects?: Record<string, unknown>[]
  done?: Record<string, number>
  red?: Record<string, number>
  amber?: Record<string, number>
  green?: Record<string, number>
  managers?: Record<string, unknown>[]
  projectPageSize?: number
} = {}) {
  const projects = opts.projects ?? []
  const done = opts.done ?? {}
  const red = opts.red ?? {}
  const amber = opts.amber ?? {}
  const green = opts.green ?? {}
  const managers = opts.managers ?? []
  listRecords.mockImplementation(async (entity: string, options?: Options) => {
    if (entity === 'project') {
      if (opts.projectPageSize) {
        const start = ((options?.page ?? 1) - 1) * opts.projectPageSize
        return projects.slice(start, start + opts.projectPageSize)
      }
      return projects
    }
    if (entity === 'users') return managers.filter((r) => options?.in?.id?.includes(String((r as { id: string }).id)))
    return []
  })
  aggregateEntity.mockImplementation(async (entity: string, _req: { aggregate: string; group?: string }, options?: { gt?: Record<string, string>; lte?: Record<string, string> }) => {
    if (entity === 'project_task') return Object.entries(done).map(([id, n]) => group(id, n))
    if (entity === 'project_risk') {
      // The query's criticity band selects the table: red > 12, amber 4..12,
      // green <= 4 (the component sends exactly these, the test asserts them).
      const table = options?.gt?.criticity === '12' ? red : options?.gt?.criticity === '4' ? amber : green
      return Object.entries(table).map(([id, n]) => group(id, n))
    }
    return []
  })
}

beforeEach(() => {
  listRecords.mockReset()
  aggregateEntity.mockReset()
  routerPush.mockReset()
  activeModules.value = new Set(['project'])
  pathnameMock.mockReturnValue('/app/project/portfolio')
})

describe('Portfolio', () => {
  it('reads the visible active projects (paged, capped at 1000)', async () => {
    const many = Array.from({ length: 2400 }, (_, i) => project(`p${i}`))
    stubPortfolio({ projects: many, projectPageSize: 200 })
    render(<Portfolio />)
    expect(await screen.findByText('First 1000 shown')).toBeInTheDocument()
    expect(listRecords).toHaveBeenCalledWith('project', expect.objectContaining({ filter: { active: 'true' } }))
    const reads = listRecords.mock.calls.filter(([entity]) => entity === 'project')
    expect(reads).toHaveLength(5)
  })

  it('feeds the counts from the named aggregates: closed tasks and the risk criticity bands', async () => {
    stubPortfolio({
      projects: [project('p1', { name: 'Alpha', task_count: 4, planned_hours: 20, spent_hours: 10, date_end: dayOffset(10) })],
      done: { p1: 2 },
      red: { p1: 1 },
    })
    render(<Portfolio />)
    await screen.findByRole('heading', { name: 'Portfolio' })
    await waitFor(() =>
      expect(aggregateEntity).toHaveBeenCalledWith(
        'project_task',
        { aggregate: 'count', group: 'project_id' },
        { filter: { closed: 'true' } },
      ),
    )
    expect(aggregateEntity).toHaveBeenCalledWith(
      'project_risk',
      { aggregate: 'count', group: 'project_id' },
      { gt: { criticity: '12' } },
    )
    expect(aggregateEntity).toHaveBeenCalledWith(
      'project_risk',
      { aggregate: 'count', group: 'project_id' },
      { gt: { criticity: '4' }, lte: { criticity: '12' } },
    )
    // The done count feeds the progress: 2 of 4 = 50%.
    expect(await screen.findByText('50%')).toBeInTheDocument()
  })

  it('plots one bubble per project: x = % tasks done, y = % hours used (capped at 200, hollow at 0 planned), size = planned hours, color = the risk band', async () => {
    stubPortfolio({
      projects: [
        project('p-red', { name: 'Redco', task_count: 10, planned_hours: 200, spent_hours: 100, date_end: dayOffset(30) }),
        project('p-none', { name: 'NoRisk', task_count: 2, planned_hours: 100, spent_hours: 25, date_end: dayOffset(30) }),
        project('p-amber', { name: 'Ambro', task_count: 4, planned_hours: 100, spent_hours: 300, date_end: dayOffset(30) }),
        project('p-zero', { name: 'ZeroPlan', task_count: 0, planned_hours: 0, spent_hours: 5, date_end: dayOffset(30) }),
      ],
      done: { 'p-red': 5, 'p-none': 1, 'p-amber': 2 },
      red: { 'p-red': 2 },
      amber: { 'p-amber': 1 },
      green: { 'p-none': 1 },
    })
    render(<Portfolio />)
    const svg = (await screen.findByRole('img', { name: 'Portfolio chart' })) as unknown as SVGElement
    const circles = [...svg.querySelectorAll('circle')]
    // One bubble per project (4) — the axes draw no circles.
    expect(circles).toHaveLength(4)
    const byName = new Map(circles.map((c) => [c.getAttribute('aria-label'), c] as const))
    const redco = byName.get('Redco')!
    const ambro = byName.get('Ambro')!
    const noRisk = byName.get('NoRisk')!
    const zeroPlan = byName.get('ZeroPlan')!
    // Desktop viewBox 0 0 560 400, plot x ∈ [44, 544] (width 500),
    // y ∈ [16, 372] (height 356): x = 44 + done%, y = 372 − used/2% · 356.
    // x = % tasks done: Redco 5/10 = 50% → the plot's middle.
    expect(redco.getAttribute('cx')).toBe('294')
    // y = % hours used: Ambro 300/100 = 300% is capped at 200% → the top of the plot.
    expect(ambro.getAttribute('cy')).toBe('16')
    // ZeroPlan has no planned hours: hollow marker at y 0, x 0 (bottom-left corner).
    expect(zeroPlan.getAttribute('fill')).toBe('none')
    expect(zeroPlan.getAttribute('cx')).toBe('44')
    expect(zeroPlan.getAttribute('cy')).toBe('372')
    // Colors come from graph-widgets' light categorical palette.
    expect(redco.getAttribute('fill')).toBe(CATEGORICAL_LIGHT[5]) // red
    expect(ambro.getAttribute('fill')).toBe(CATEGORICAL_LIGHT[2]) // amber
    expect(noRisk.getAttribute('fill')).toBe(CATEGORICAL_LIGHT[1]) // green
    expect(zeroPlan.getAttribute('stroke')).toBe(CHROME_LIGHT.mutedInk) // grey
    // The table says "—" for the hours of a project with no planned hours.
    // The row's aria-label is the project name (an exact match: this
    // @testing-library/dom version takes no jest matchers as query names).
    expect(within(screen.getByRole('row', { name: 'ZeroPlan' })).getByText('—')).toBeInTheDocument()
  })

  it('the table shows name, manager, progress, hours, end date, the Late flag and the risk dot; clicking a row or a bubble opens the project tasks', async () => {
    stubPortfolio({
      projects: [
        project('p1', { name: 'Lateco', manager_id: 'm1', task_count: 10, planned_hours: 200, spent_hours: 200, date_end: dayOffset(-1) }),
        project('p2', { name: 'Oontime', manager_id: 'm1', task_count: 10, planned_hours: 100, spent_hours: 50, date_end: dayOffset(1) }),
      ],
      done: { p1: 5, p2: 2 },
      red: { p1: 1 },
      managers: [{ id: 'm1', email: 'mgr@example.com' }],
    })
    render(<Portfolio />)
    const lateRow = await screen.findByRole('row', { name: 'Lateco' })
    // Name, manager email, progress, hours, end date.
    expect(within(lateRow).getByText('Lateco')).toBeInTheDocument()
    expect(within(lateRow).getByText('mgr@example.com')).toBeInTheDocument()
    expect(within(lateRow).getByText('50%')).toBeInTheDocument()
    expect(within(lateRow).getByText('200 / 200')).toBeInTheDocument()
    // Late: date_end in the past with 50% done.
    expect(within(lateRow).getByText('Late')).toBeInTheDocument()
    // Oontime (ends tomorrow, 20% done) is not flagged.
    const oontime = screen.getByRole('row', { name: 'Oontime' })
    expect(within(oontime).queryByText('Late')).not.toBeInTheDocument()
    // The risk dot is drawn (an aria-labelled mark, not color alone).
    expect(within(lateRow).getByTitle('red')).toBeInTheDocument()
    // Row click: the project's tasks.
    fireEvent.click(lateRow)
    expect(routerPush).toHaveBeenCalledWith('/app/project/tasks?filter[project_id]=p1')
    // Bubble click: the same target.
    const bubble = screen.getByRole('img', { name: 'Portfolio chart' }).querySelector('circle[aria-label="Oontime"]')!
    fireEvent.click(bubble)
    expect(routerPush).toHaveBeenCalledWith('/app/project/tasks?filter[project_id]=p2')
  })

  it('at 390px the chart is square and full width and the table becomes cards', async () => {
    const real = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
    try {
      stubPortfolio({
        projects: [project('p1', { name: 'Lateco', task_count: 10, planned_hours: 200, spent_hours: 100, date_end: dayOffset(-1) })],
        done: { p1: 5 },
      })
      render(<Portfolio />)
      const svg = (await screen.findByRole('img', { name: 'Portfolio chart' })) as unknown as SVGElement
      expect(svg.closest('div')!.style.width).toBe('100%')
      expect(svg.closest('div')!.style.aspectRatio).toBe('1 / 1')
      // Cards instead of table rows.
      const card = await screen.findByRole('article', { name: 'Lateco' })
      expect(card).toBeInTheDocument()
      expect(within(card).getByText('50%')).toBeInTheDocument()
    } finally {
      window.matchMedia = real
    }
  })

  it('the page is a 404 while the project module is inactive', async () => {
    activeModules.value = new Set()
    await expect(PortfolioPage()).rejects.toThrow('NOT_FOUND')
  })

  it('the page renders the Portfolio view for a signed-in user', async () => {
    stubPortfolio({ projects: [] })
    render(await PortfolioPage())
    expect(await screen.findByRole('heading', { name: 'Portfolio' })).toBeInTheDocument()
  })
})
