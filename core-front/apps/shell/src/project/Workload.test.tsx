import { createTheme } from '@mui/material/styles'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

// next/navigation: the page guard (notFound/redirect) plus the router push a
// cell click performs.
const notFound = vi.fn(() => { throw new Error('NOT_FOUND') })
const redirect = vi.fn((url: string) => { throw new Error(`REDIRECT ${url}`) })
const pathnameMock = vi.fn(() => '/app/project/workload')
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
  permissions: ['project_task:project_task:read', 'project:project:read', 'project_capacity:project_capacity:read', 'users:users:read'],
}))
const requireAuth = vi.fn(async () => identity)
vi.mock('@/lib/session', () => ({ requireAuth: () => requireAuth() }))
const activeModules = vi.hoisted(() => ({ value: new Set(['project']) }))
vi.mock('@/lib/module-state', () => ({ activeModuleNames: async () => activeModules.value }))
// The relation-actions layer: the page's only data path (no BFF route).
const listRecords = vi.fn()
const getRecord = vi.fn()
vi.mock('@/lib/relation-actions', () => ({
  listRecords: (...a: unknown[]) => listRecords(...a),
  getRecord: (...a: unknown[]) => getRecord(...a),
}))

import { Workload } from './Workload'
import WorkloadPage from '../../app/app/project/workload/page'

type Options = {
  filter?: Record<string, string>
  in?: Record<string, string[]>
  order?: string
  page?: number
  pageSize?: number
  gte?: Record<string, string>
  gt?: Record<string, string>
  lt?: Record<string, string>
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
/** Monday of the week containing `d`, as ISO. */
const mondayOf = (d: Date) => {
  const x = new Date(d)
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return iso(x)
}
/** The day `n` after this week's Monday, as ISO (n=0 is Monday). */
const w = (n: number) => {
  const d = new Date(`${mondayOf(new Date())}T00:00:00`)
  d.setDate(d.getDate() + n)
  return iso(d)
}
const monday = mondayOf(new Date())
const weekEnd = (() => {
  const d = new Date(`${monday}T00:00:00`)
  d.setDate(d.getDate() + 56)
  return iso(d)
})()

type TaskRow = { id: string; project_id: string; date_start: string; deadline: string; planned_hours: number; [k: string]: unknown }
const task = (id: string, over: Record<string, unknown> = {}): TaskRow => ({
  id, project_id: 'p1', date_start: w(0), deadline: w(4), planned_hours: 10, ...over,
})
const assignee = (task_id: string, user_id: string) => ({ id: `${task_id}-${user_id}`, task_id, user_id })
const project = (id: string, name: string) => ({ id, name })

/** Stub every entity the page reads: projects, the window's tasks (honoring
 * the Project filter), their assignees, capacities and user labels. */
function stubWorkload(opts: {
  projects?: Record<string, unknown>[]
  tasks?: TaskRow[]
  assignees?: Record<string, unknown>[]
  capacities?: Record<string, unknown>[]
  users?: Record<string, unknown>[]
  taskPageSize?: number
} = {}) {
  const projects = opts.projects ?? [project('p1', 'Alpha'), project('p2', 'Beta')]
  const tasks = opts.tasks ?? []
  const assignees = opts.assignees ?? []
  const capacities = opts.capacities ?? []
  const users = opts.users ?? []
  listRecords.mockImplementation(async (entity: string, options?: Options) => {
    switch (entity) {
      case 'project':
        return projects
      case 'project_task': {
        const projectId = options?.filter?.project_id
        const filtered = projectId ? tasks.filter((t) => t.project_id === projectId) : tasks
        if (opts.taskPageSize) {
          // The cap test: a server that always answers a full page.
          const start = ((options?.page ?? 1) - 1) * opts.taskPageSize
          return filtered.slice(start, start + opts.taskPageSize)
        }
        return filtered
      }
      case 'project_task_user':
        return assignees.filter((r) => options?.in?.task_id?.includes(String((r as TaskRow).task_id)))
      case 'project_capacity':
        return capacities
      case 'users':
        return users.filter((r) => options?.in?.id?.includes(String((r as { id: string }).id)))
      default:
        return []
    }
  })
}

const theme = createTheme()

beforeEach(() => {
  listRecords.mockReset()
  getRecord.mockReset()
  routerPush.mockReset()
  activeModules.value = new Set(['project'])
  pathnameMock.mockReturnValue('/app/project/workload')
  stubWorkload()
})

describe('Workload', () => {
  it('shows an 8-week window with a row per assignee plus Unassigned, read with the window filters', async () => {
    stubWorkload({
      tasks: [task('t1', { planned_hours: 10 }), task('t2', { planned_hours: 5 })],
      assignees: [assignee('t1', 'ada')],
      users: [{ id: 'ada', email: 'ada@example.com' }],
    })
    render(<Workload />)
    // 1 user column + 8 week columns.
    expect(await screen.findByRole('columnheader', { name: 'User' })).toBeInTheDocument()
    expect(screen.getAllByRole('columnheader')).toHaveLength(9)
    // The task read is the Global-Constraints query: open tasks with planned
    // hours overlapping the 8-week window (Mon of this week .. +56 days).
    expect(listRecords).toHaveBeenCalledWith(
      'project_task',
      expect.objectContaining({
        filter: { closed: 'false' },
        gte: { deadline: monday },
        lt: { date_start: weekEnd },
        gt: { planned_hours: '0' },
      }),
    )
    // Rows: the assignee (by email) and the Unassigned row.
    expect(screen.getByRole('row', { name: 'ada@example.com' })).toBeInTheDocument()
    expect(screen.getByRole('row', { name: 'Unassigned' })).toBeInTheDocument()
    // 10 h over Mon–Fri of this week for ada, 5 h unassigned.
    expect(within(screen.getByRole('row', { name: 'ada@example.com' })).getByText('10')).toBeInTheDocument()
    expect(within(screen.getByRole('row', { name: 'Unassigned' })).getByText('5')).toBeInTheDocument()
  })

  it('colors the cells by load/capacity with the capacity read from project_capacity (40 by default)', async () => {
    stubWorkload({
      tasks: [
        task('t-ada', { planned_hours: 40 }),
        task('t-bob', { planned_hours: 45 }),
        task('t-carol', { planned_hours: 10 }),
        task('t-dave', { planned_hours: 50 }),
      ],
      assignees: [assignee('t-ada', 'ada'), assignee('t-bob', 'bob'), assignee('t-carol', 'carol'), assignee('t-dave', 'dave')],
      capacities: [{ id: 'c1', user_id: 'bob', hours_per_week: 45 }],
      users: [
        { id: 'ada', email: 'ada@example.com' },
        { id: 'bob', email: 'bob@example.com' },
        { id: 'carol', email: 'carol@example.com' },
        { id: 'dave', email: 'dave@example.com' },
      ],
    })
    render(<Workload />)
    await screen.findByRole('row', { name: 'ada@example.com' })
    // The capacities were read.
    expect(listRecords).toHaveBeenCalledWith('project_capacity', expect.objectContaining({ page: 1, pageSize: expect.any(Number) }))
    // ada: 40 h / default 40 = 1.0 → amber.
    expect(within(screen.getByRole('row', { name: 'ada@example.com' })).getByRole('button')).toHaveStyle({
      backgroundColor: theme.palette.warning.main,
    })
    // bob: 45 h / his 45 from project_capacity = 1.0 → amber (the default 40
    // would have turned the cell red, so the row was used).
    expect(within(screen.getByRole('row', { name: 'bob@example.com' })).getByRole('button')).toHaveStyle({
      backgroundColor: theme.palette.warning.main,
    })
    // dave: 50 h / default 40 = 1.25 → red.
    expect(within(screen.getByRole('row', { name: 'dave@example.com' })).getByRole('button')).toHaveStyle({
      backgroundColor: theme.palette.error.main,
    })
    // carol: 10 h / default 40 = 0.25 → neutral (no colored background).
    expect(within(screen.getByRole('row', { name: 'carol@example.com' })).getByRole('button')).not.toHaveStyle({
      backgroundColor: theme.palette.error.main,
    })
    expect(within(screen.getByRole('row', { name: 'carol@example.com' })).getByRole('button')).not.toHaveStyle({
      backgroundColor: theme.palette.warning.main,
    })
  })

  it('the Project filter narrows the tasks to the picked project', async () => {
    stubWorkload({
      projects: [project('p1', 'Alpha'), project('p2', 'Beta')],
      tasks: [
        task('t1', { project_id: 'p1', planned_hours: 10 }),
        task('t2', { project_id: 'p2', planned_hours: 4 }),
      ],
      assignees: [assignee('t1', 'ada'), assignee('t2', 'ada')],
      users: [{ id: 'ada', email: 'ada@example.com' }],
    })
    render(<Workload />)
    await screen.findByRole('columnheader', { name: 'User' })
    // Both projects' hours are in the cell: 14.
    expect(within(screen.getByRole('row', { name: 'ada@example.com' })).getByText('14')).toBeInTheDocument()
    fireEvent.mouseDown(screen.getByRole('combobox'))
    fireEvent.click(await screen.findByRole('option', { name: 'Beta' }))
    await waitFor(() =>
      expect(listRecords).toHaveBeenCalledWith(
        'project_task',
        expect.objectContaining({ filter: { closed: 'false', project_id: 'p2' } }),
      ),
    )
    // Only Beta's 4 h remain.
    await waitFor(() => expect(within(screen.getByRole('row', { name: 'ada@example.com' })).getByText('4')).toBeInTheDocument())
    expect(within(screen.getByRole('row', { name: 'ada@example.com' })).queryByText('14')).not.toBeInTheDocument()
  })

  it('clicking a cell opens the task list filtered to that user', async () => {
    stubWorkload({
      tasks: [task('t1', { planned_hours: 10 })],
      assignees: [assignee('t1', 'ada')],
      users: [{ id: 'ada', email: 'ada@example.com' }],
    })
    render(<Workload />)
    // The cell of ada's row for the current week (its aria-label is "email + Monday").
    const cell = await screen.findByRole('button', { name: `ada@example.com ${monday}` })
    fireEvent.click(cell)
    expect(routerPush).toHaveBeenCalledWith('/app/project/tasks?filter[assignees]=ada')
  })

  it('caps the task read at 1000 rows and says so', async () => {
    const many = Array.from({ length: 2400 }, (_, i) => task(`t${i}`, { planned_hours: 1 }))
    stubWorkload({ tasks: many, taskPageSize: 200, users: [], assignees: [] })
    render(<Workload />)
    expect(await screen.findByText('First 1000 shown')).toBeInTheDocument()
    // 200 per page: pages 1–5 fill the cap, the loop stops there.
    const taskReads = listRecords.mock.calls.filter(([entity]) => entity === 'project_task')
    expect(taskReads).toHaveLength(5)
  })

  it('at 390px the window is 4 weeks, the user column is sticky and the weeks scroll inside the box', async () => {
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
      stubWorkload({
        tasks: [task('t1', { planned_hours: 10 })],
        assignees: [assignee('t1', 'ada')],
        users: [{ id: 'ada', email: 'ada@example.com' }],
      })
      render(<Workload />)
      // 1 user column + 4 week columns only.
      await screen.findByRole('columnheader', { name: 'User' })
      expect(screen.getAllByRole('columnheader')).toHaveLength(5)
      // The window query covers 4 weeks (28 days), not 8.
      expect(listRecords).toHaveBeenCalledWith(
        'project_task',
        expect.objectContaining({
          gte: { deadline: monday },
          lt: { date_start: (() => { const d = new Date(`${monday}T00:00:00`); d.setDate(d.getDate() + 28); return iso(d) })() },
        }),
      )
      const row = screen.getByRole('row', { name: 'ada@example.com' })
      const userCell = (row as HTMLTableRowElement).cells[0]
      expect(userCell).toHaveStyle({ position: 'sticky', left: '0px' })
      // The weeks scroll horizontally inside their own box.
      expect(row.closest('table')!.parentElement).toHaveStyle({ overflowX: 'auto' })
    } finally {
      window.matchMedia = real
    }
  })

  it('the page is a 404 while the project module is inactive', async () => {
    activeModules.value = new Set()
    await expect(WorkloadPage()).rejects.toThrow('NOT_FOUND')
  })

  it('the page renders the Workload view for a signed-in user', async () => {
    stubWorkload({ tasks: [], assignees: [] })
    render(await WorkloadPage())
    expect(await screen.findByRole('heading', { name: 'Workload' })).toBeInTheDocument()
  })
})
