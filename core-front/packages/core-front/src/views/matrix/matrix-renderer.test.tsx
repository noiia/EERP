import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { MatrixConfig } from '../../api/view-fields'
import { ApiError } from '../../api/errors'
import { RelationOpsProvider, type RelationOps } from '../relation-ops'
import { setViewportWidth } from '../../test/viewport'
import { MatrixRenderer, type MatrixTask } from './matrix-renderer'
import { humanDeadline } from './eisenhower'
import { exportElementPdf, exportElementPng } from '../diagram/export'

const push = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('../diagram/export', () => ({ exportElementPng: vi.fn(), exportElementPdf: vi.fn() }))

const canWriteTask = vi.hoisted(() => ({ value: true }))
const canWriteRaci = vi.hoisted(() => ({ value: true }))
vi.mock('../../auth/Can', () => ({
  usePermission: (permission: string) =>
    permission === 'project_task_raci:project_task_raci:write' ? canWriteRaci.value : canWriteTask.value,
}))

const PAGE = 200

/** Task fixture with the fields the matrices read (wbs_number literal). */
function task(id: string, extra: Record<string, unknown> = {}): MatrixTask {
  return {
    id,
    name: `Task ${id}`,
    wbs_number: id,
    priority: false,
    deadline: null,
    closed: false,
    ...extra,
  }
}

const BASE_CONFIG: MatrixConfig = {
  projectField: 'project_id',
  raciEntity: 'project_task_raci',
  userLabelField: 'display_name',
  dependencies: { entity: 'project_task_dependency', fromField: 'depends_on_id', toField: 'task_id' },
  priorityField: 'priority',
  deadlineField: 'deadline',
  closedField: 'closed',
  urgentDays: 7,
  taskEntity: 'project_task',
  taskFormPath: '/project/tasks/:id',
}

const USERS = [
  { id: 'm1', email: 'manager@ex.com', display_name: 'boss' },
  { id: 'u2', email: 'member@ex.com' },
  { id: 'u3', email: 'other@ex.com' },
  { id: 'u9', email: 'holder@ex.com' },
]

interface OpsFixtures {
  tasks?: MatrixTask[]
  members?: Array<Record<string, unknown>>
  raci?: Array<Record<string, unknown>>
  deps?: Array<Record<string, unknown>>
  failTasks?: boolean
}

function opsFixture(fix: OpsFixtures = {}) {
  const create = vi.fn(async (_entity: string, body: Record<string, unknown>) => ({
    id: 'new-raci',
    created_at: '2026-06-01T00:00:00Z',
    ...body,
  }))
  const update = vi.fn(async (_entity: string, id: string, body: Record<string, unknown>) => ({ id, ...body }))
  const remove = vi.fn(async () => undefined)
  const listPage = vi.fn(async (entity: string, options?: { filter?: Record<string, string>; in?: Record<string, string[]>; order?: string; page?: number; pageSize?: number }) => {
    const page = options?.page ?? 1
    const pageSize = options?.pageSize ?? 20
    if (entity === 'project_task') {
      if (fix.failTasks) throw new ApiError({ code: 'FORBIDDEN', message: 'nope', status: 403 })
      const all = fix.tasks ?? []
      return { records: all.slice((page - 1) * pageSize, page * pageSize), total: all.length }
    }
    if (entity === 'project_task_dependency') {
      const all = (fix.deps ?? []).filter((d) => (options?.in?.task_id ?? []).includes(d.task_id as string))
      return { records: all.slice((page - 1) * pageSize, page * pageSize), total: all.length }
    }
    if (entity === 'project_member') {
      return { records: fix.members ?? [], total: (fix.members ?? []).length }
    }
    if (entity === 'project_task_raci') {
      return { records: fix.raci ?? [], total: (fix.raci ?? []).length }
    }
    if (entity === 'users') {
      const all = USERS.filter((u) => (options?.in?.id ?? []).includes(u.id))
      return { records: all.slice((page - 1) * pageSize, page * pageSize), total: all.length }
    }
    return { records: [], total: 0 }
  })
  const ops = {
    list: vi.fn(),
    get: vi.fn(async (entity: string, id: string) =>
      entity === 'project' ? { id, name: 'Acme', manager_id: 'm1' } : entity === 'users' ? USERS.find((u) => u.id === id) : { id },
    ),
    listPage,
    create,
    update,
    remove,
  }
  return { ops: ops as unknown as RelationOps, listPage, create, update, remove }
}

function renderRenderer(ops: RelationOps, config: MatrixConfig = BASE_CONFIG) {
  return render(
    <RelationOpsProvider ops={ops}>
      <MatrixRenderer config={config} projectId="p1" />
    </RelationOpsProvider>,
  )
}

describe('MatrixRenderer', () => {
  beforeEach(() => {
    push.mockReset()
    canWriteTask.value = true
    canWriteRaci.value = true
    setViewportWidth(1280)
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('offers the Eisenhower, RACI and Dependencies tabs, loading the project tasks once', async () => {
    const { ops, listPage } = opsFixture({ tasks: [task('t1')] })
    renderRenderer(ops)
    expect(await screen.findByRole('tab', { name: 'Eisenhower' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'RACI' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Dependencies' })).toBeTruthy()
    const taskCalls = listPage.mock.calls.filter(([entity]) => entity === 'project_task')
    expect(taskCalls.length).toBe(1)
    expect(taskCalls[0]).toEqual([
      'project_task',
      { filter: { project_id: 'p1' }, order: 'created_at', page: 1, pageSize: PAGE },
    ])
  })

  it('shows the error alert when the read fails', async () => {
    const { ops } = opsFixture({ failTasks: true })
    renderRenderer(ops)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('alert').textContent).toContain('nope')
  })

  it('stops the tasks read at 1000 and says so', async () => {
    const big = Array.from({ length: 1001 }, (_, i) => task(`t${i}`, { wbs_number: `1.${i}` }))
    const { ops, listPage } = opsFixture({ tasks: big })
    renderRenderer(ops)
    expect(await screen.findByText('First 1000 shown')).toBeInTheDocument()
    const taskCalls = listPage.mock.calls.filter(([entity]) => entity === 'project_task')
    // 5 full pages of 200 plus the one probe page past the cap.
    expect(taskCalls.length).toBe(6)
  }, 30_000)
})

describe('MatrixRenderer Eisenhower tab', () => {
  beforeEach(() => {
    setViewportWidth(1280)
    canWriteTask.value = true
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('Eisenhower puts tasks in the four quadrants per the Global Constraints, with `urgentDays` from config and today mocked.', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-10T12:00:00Z'))
    const tasks = [
      // important + urgent (deadline inside the 7-day window) -> Do
      task('t1', { priority: true, deadline: '2026-06-15T00:00:00Z' }),
      // important, not urgent -> Schedule
      task('t2', { priority: true, deadline: '2026-06-20T00:00:00Z' }),
      // urgent (overdue), not important -> Delegate
      task('t3', { priority: false, deadline: '2026-06-01T00:00:00Z' }),
      // neither -> Eliminate
      task('t4', { priority: false, deadline: '2026-07-01T00:00:00Z' }),
      // boundary: deadline exactly now + urgentDays is NOT urgent -> Schedule
      task('t5', { priority: true, deadline: '2026-06-17T12:00:00Z' }),
      // closed tasks never appear, even when important and overdue
      task('t6', { priority: true, deadline: '2026-06-01T00:00:00Z', closed: true }),
    ]
    const { ops } = opsFixture({ tasks })
    renderRenderer(ops)

    const doBox = await screen.findByTestId('eisenhower-do')
    const scheduleBox = screen.getByTestId('eisenhower-schedule')
    const delegateBox = screen.getByTestId('eisenhower-delegate')
    const eliminateBox = screen.getByTestId('eisenhower-eliminate')
    expect(within(doBox).getByTestId('eis-card-t1')).toBeInTheDocument()
    expect(within(scheduleBox).getByTestId('eis-card-t2')).toBeInTheDocument()
    expect(within(scheduleBox).getByTestId('eis-card-t5')).toBeInTheDocument()
    expect(within(delegateBox).getByTestId('eis-card-t3')).toBeInTheDocument()
    expect(within(eliminateBox).getByTestId('eis-card-t4')).toBeInTheDocument()
    for (const box of [doBox, scheduleBox, delegateBox, eliminateBox]) {
      expect(box).not.toHaveTextContent('Task t6')
    }

    // `urgentDays` comes from the config: with a 1-day window t1 (due in 5 days)
    // is no longer urgent and leaves the Do quadrant.
    cleanup()
    const { ops: ops1 } = opsFixture({ tasks })
    renderRenderer(ops1, { ...BASE_CONFIG, urgentDays: 1 })
    const doBox1 = await screen.findByTestId('eisenhower-do')
    const scheduleBox1 = screen.getByTestId('eisenhower-schedule')
    expect(within(doBox1).queryByTestId('eis-card-t1')).toBeNull()
    expect(within(scheduleBox1).getByTestId('eis-card-t1')).toBeInTheDocument()
  })

  it('A card\'s `Toggle priority` button (write permission only) PATCHes `{ priority: !p }` through `useOptimisticFieldMove` and the card changes quadrant.', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-10T12:00:00Z'))
    const tasks = [
      task('t1', { priority: false, deadline: '2026-07-01T00:00:00Z' }),
      task('t2', { priority: true, deadline: '2026-06-15T00:00:00Z' }),
    ]
    // Write permission only: without it the button is absent.
    canWriteTask.value = false
    const { ops: opsRead } = opsFixture({ tasks })
    renderRenderer(opsRead)
    expect(within(await screen.findByTestId('eisenhower-eliminate')).queryByRole('button', { name: 'Toggle priority' })).toBeNull()
    cleanup()
    canWriteTask.value = true

    const { ops, update } = opsFixture({ tasks })
    renderRenderer(ops)
    await screen.findByTestId('eisenhower-eliminate')

    // t1: not important, not urgent -> Eliminate. Toggle to priority -> Schedule.
    const t1Card = within(screen.getByTestId('eisenhower-eliminate')).getByTestId('eis-card-t1')
    fireEvent.click(within(t1Card).getByRole('button', { name: 'Toggle priority' }))
    expect(update).toHaveBeenCalledWith('project_task', 't1', { priority: true })
    expect(within(screen.getByTestId('eisenhower-schedule')).getByTestId('eis-card-t1')).toBeInTheDocument()
    expect(within(screen.getByTestId('eisenhower-eliminate')).queryByTestId('eis-card-t1')).toBeNull()

    // Toggle back -> Eliminate again.
    fireEvent.click(within(screen.getByTestId('eisenhower-schedule')).getByRole('button', { name: 'Toggle priority' }))
    expect(update).toHaveBeenLastCalledWith('project_task', 't1', { priority: false })
    expect(within(screen.getByTestId('eisenhower-eliminate')).getByTestId('eis-card-t1')).toBeInTheDocument()

    // A rejected PATCH reverts the card and surfaces the error.
    update.mockRejectedValueOnce(new ApiError({ code: 'VALIDATION', message: 'bad move', status: 422 }))
    const t2Card = within(screen.getByTestId('eisenhower-do')).getByTestId('eis-card-t2')
    fireEvent.click(within(t2Card).getByRole('button', { name: 'Toggle priority' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('bad move')
    // Reverted: t2 is back where it started (Do).
    expect(within(screen.getByTestId('eisenhower-do')).getByTestId('eis-card-t2')).toBeInTheDocument()
  })

  it('On phone the quadrants stack as four collapsible sections with counts.', async () => {
    setViewportWidth(390)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-10T12:00:00Z'))
    const tasks = [
      task('t1', { priority: true, deadline: '2026-06-15T00:00:00Z' }),
      task('t2', { priority: true, deadline: '2026-06-20T00:00:00Z' }),
      task('t3', { priority: false, deadline: '2026-06-01T00:00:00Z' }),
      task('t4', { priority: false, deadline: '2026-07-01T00:00:00Z' }),
    ]
    const { ops } = opsFixture({ tasks })
    renderRenderer(ops)

    // One column on phone, four stacked sections with their task counts.
    const list = await screen.findByTestId('eisenhower-list')
    expect(getComputedStyle(list).gridTemplateColumns).toBe('1fr')
    expect(screen.getByText('Do (1)')).toBeInTheDocument()
    expect(screen.getByText('Schedule (1)')).toBeInTheDocument()
    expect(screen.getByText('Delegate (1)')).toBeInTheDocument()
    expect(screen.getByText('Eliminate (1)')).toBeInTheDocument()

    // Collapsible: collapsing the Do section hides its card, the count stays.
    fireEvent.click(screen.getByText('Do (1)'))
    expect(screen.queryByTestId('eis-card-t1')).toBeNull()
    expect(screen.getByText('Do (1)')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Do (1)'))
    expect(screen.getByTestId('eis-card-t1')).toBeInTheDocument()

    // Reachable controls keep the 40px minimum height.
    const toggle = within(screen.getByTestId('eis-card-t1')).getByRole('button', { name: 'Toggle priority' })
    expect(getComputedStyle(toggle).minHeight).toBe('40px')
  })
})

describe('MatrixRenderer Dependencies (DSM) tab', () => {
  beforeEach(() => {
    setViewportWidth(1280)
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('The DSM rows and columns are the tasks in `wbs_number` order. A dependency `A depends on B` marks cell (A, B). The diagonal is grey. Over 150 tasks it shows `First 150 tasks shown` (cap). Hovering a cell highlights its row and column. Tapping a mark opens the dependent task.', async () => {
    // WBS order 1, 2, 3, 4 but handed out shuffled on purpose.
    const tasks = [task('D', { wbs_number: '4' }), task('B', { wbs_number: '2' }), task('A', { wbs_number: '1' }), task('C', { wbs_number: '3' })]
    const deps = [{ task_id: 'B', depends_on_id: 'A', id: 'd1' }]
    const { ops, listPage } = opsFixture({ tasks, deps })
    renderRenderer(ops)

    fireEvent.click(await screen.findByRole('tab', { name: 'Dependencies' }))
    const colA = await screen.findByTestId('dsm-col-0')
    expect(colA).toHaveTextContent('Task A')
    expect(screen.getByTestId('dsm-col-1')).toHaveTextContent('Task B')
    expect(screen.getByTestId('dsm-col-2')).toHaveTextContent('Task C')
    expect(screen.getByTestId('dsm-col-3')).toHaveTextContent('Task D')
    expect(screen.getByTestId('dsm-row-0')).toHaveTextContent('Task A')
    expect(screen.getByTestId('dsm-row-3')).toHaveTextContent('Task D')

    // Dependencies are fetched by chunks over the visible task ids.
    const depCalls = listPage.mock.calls.filter(([entity]) => entity === 'project_task_dependency')
    expect(depCalls.length).toBe(1)
    expect(depCalls[0][1]).toMatchObject({
      in: { task_id: ['A', 'B', 'C', 'D'] },
      order: 'task_id',
      pageSize: 200,
    })

    // B depends on A -> the mark sits at cell (row B, column A) = cell 1-0.
    const mark = screen.getByTestId('dsm-mark-1-0')
    expect(within(screen.getByTestId('dsm-cell-1-0')).getByRole('button', { name: 'Task A' })).toBe(mark)
    // The diagonal is greyed: cell (A, A) is flagged and tinted.
    const diagonal = screen.getByTestId('dsm-cell-0-0')
    expect(diagonal).toHaveAttribute('data-diagonal', '')
    expect(getComputedStyle(diagonal).backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
    // An unmarked, non-diagonal cell is plain.
    expect(getComputedStyle(screen.getByTestId('dsm-cell-1-2')).backgroundColor).toBe('rgba(0, 0, 0, 0)')

    // Hovering a cell highlights its whole row and column.
    const cell12 = screen.getByTestId('dsm-cell-1-2') // row B, column C
    fireEvent.mouseEnter(cell12)
    expect(getComputedStyle(cell12).backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
    expect(getComputedStyle(screen.getByTestId('dsm-cell-1-0')).backgroundColor).not.toBe('rgba(0, 0, 0, 0)') // same row
    expect(getComputedStyle(screen.getByTestId('dsm-cell-1-3')).backgroundColor).not.toBe('rgba(0, 0, 0, 0)') // same row
    expect(getComputedStyle(screen.getByTestId('dsm-cell-0-2')).backgroundColor).not.toBe('rgba(0, 0, 0, 0)') // same column
    expect(getComputedStyle(screen.getByTestId('dsm-cell-0-3')).backgroundColor).toBe('rgba(0, 0, 0, 0)') // untouched row/column

    // Tapping the mark opens the dependent task form (the row's task, B).
    fireEvent.click(mark)
    expect(push).toHaveBeenCalledWith('/app/project/tasks/B')

    // Over 150 tasks the grid caps at 150 rows and columns and says so.
    cleanup()
    const big = Array.from({ length: 151 }, (_, i) => task(`t${i}`, { wbs_number: String(i) }))
    const { ops: opsBig } = opsFixture({ tasks: big })
    renderRenderer(opsBig)
    fireEvent.click(await screen.findByRole('tab', { name: 'Dependencies' }))
    expect(await screen.findByText('First 150 tasks shown')).toBeInTheDocument()
    expect(screen.getByTestId('dsm-row-149')).toBeInTheDocument()
    expect(screen.queryByTestId('dsm-row-150')).toBeNull()
    expect(screen.queryByTestId('dsm-col-150')).toBeNull()
  }, 60_000)

  it('On phone the DSM scrolls inside its own box with sticky row and column headers.', async () => {
    setViewportWidth(390)
    const tasks = [task('A', { wbs_number: '1' }), task('B', { wbs_number: '2' }), task('C', { wbs_number: '3' })]
    const { ops } = opsFixture({ tasks, deps: [{ task_id: 'C', depends_on_id: 'A', id: 'd1' }] })
    renderRenderer(ops)
    fireEvent.click(await screen.findByRole('tab', { name: 'Dependencies' }))
    const box = await screen.findByTestId('dsm-box')
    expect(getComputedStyle(box).overflow).toBe('auto')
    const rowHeader = screen.getByTestId('dsm-row-0')
    const colHeader = screen.getByTestId('dsm-col-0')
    expect(getComputedStyle(rowHeader).position).toBe('sticky')
    expect(getComputedStyle(rowHeader).left).toBe('0px')
    expect(getComputedStyle(colHeader).position).toBe('sticky')
    expect(getComputedStyle(colHeader).top).toBe('0px')
  })
})

describe('MatrixRenderer RACI tab', () => {
  const RACI_TASKS = [task('t3', { wbs_number: '3' }), task('t1', { wbs_number: '1' }), task('t2', { wbs_number: '2' })]
  const RACI_MEMBERS = [
    { id: 'pm3', user_id: 'u3', created_at: '2026-06-02T00:00:00Z' },
    { id: 'pm2', user_id: 'u2', created_at: '2026-06-01T00:00:00Z' },
  ]
  const RACI_ROWS = [{ id: 'r1', task_id: 't2', user_id: 'u9', role: 'A', created_at: '2026-06-01T00:00:00Z' }]

  beforeEach(() => {
    setViewportWidth(1280)
    canWriteRaci.value = true
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it("Columns are the project's manager plus members (the `project_member` rows, plus anyone already holding a RACI role). Rows are tasks in WBS order.", async () => {
    const { ops } = opsFixture({ tasks: RACI_TASKS, members: RACI_MEMBERS, raci: RACI_ROWS })
    renderRenderer(ops)
    fireEvent.click(await screen.findByRole('tab', { name: 'RACI' }))
    const header = await screen.findByTestId('raci-header')
    // Manager first, then the members in created_at order, then the role holder.
    expect(within(header).getAllByTestId(/raci-col-/).map((el) => el.textContent)).toEqual([
      'boss',
      'member',
      'other',
      'holder',
    ])
    // Rows in wbs_number order despite the shuffled fetch order (the row
    // cells carry the task id; the first distinct ids in reading order are
    // the row order).
    const grid = screen.getByTestId('raci-grid')
    const rowOrder = [
      ...new Set(
        within(grid)
          .getAllByTestId(/^raci-cell-/)
          .map((el) => (el.getAttribute('data-testid') ?? '').replace('raci-cell-', '').split('-')[0]),
      ),
    ]
    expect(rowOrder).toEqual(['t1', 't2', 't3'])
    // The stored role letter sits in its cell; an unassigned cell is blank.
    expect(screen.getByTestId('raci-cell-t2-u9').textContent).toBe('A')
    expect(screen.getByTestId('raci-cell-t1-u2').textContent).toBe('')
  })

  it('With write permission, a click opens a role menu: choosing another role updates the same row, clicking the selected role clears it; a rejection shows the message and keeps what committed. A row without an `A` is flagged `No one accountable`.', async () => {
    const { ops, create, update, remove } = opsFixture({ tasks: RACI_TASKS, members: RACI_MEMBERS, raci: RACI_ROWS })
    renderRenderer(ops)
    fireEvent.click(await screen.findByRole('tab', { name: 'RACI' }))
    await screen.findByTestId('raci-cell-t1-u2')
    const cellT1 = () => screen.getByTestId('raci-cell-t1-u2')
    const settle = () => act(async () => {})
    const item = (role: string) => within(screen.getByRole('menu')).getByText(role)

    fireEvent.click(cellT1())
    fireEvent.click(item('A'))
    expect(create).toHaveBeenCalledWith('project_task_raci', { task_id: 't1', user_id: 'u2', role: 'A' })
    expect(cellT1().textContent).toBe('A')
    await settle()
    fireEvent.click(item('R'))
    expect(update).toHaveBeenLastCalledWith('project_task_raci', 'new-raci', { role: 'R' })
    await settle()
    expect(cellT1().textContent).toBe('R')
    fireEvent.click(item('R'))
    expect(remove).toHaveBeenCalledWith('project_task_raci', 'new-raci')
    await settle()
    expect(cellT1().textContent).toBe('')
    fireEvent.click(item('R'))
    await settle()

    update.mockRejectedValueOnce(new ApiError({ code: 'FORBIDDEN', message: 'nope', status: 403 }))
    fireEvent.click(item('C'))
    expect(await screen.findByText('nope')).toBeInTheDocument()
    expect(cellT1().textContent).toBe('R')

    expect(screen.getByTestId('raci-row-t1')).toHaveTextContent('No one accountable')
    expect(screen.getByTestId('raci-row-t2')).not.toHaveTextContent('No one accountable')
  })

  it('removes the previous role before creating its replacement when update is unavailable', async () => {
    const { ops, remove, create } = opsFixture({ tasks: RACI_TASKS, members: RACI_MEMBERS, raci: RACI_ROWS })
    renderRenderer({ ...ops, update: undefined })
    fireEvent.click(await screen.findByRole('tab', { name: 'RACI' }))
    fireEvent.click(await screen.findByTestId('raci-cell-t2-u9'))
    fireEvent.click(within(screen.getByRole('menu')).getByText('R'))
    await act(async () => {})
    expect(remove).toHaveBeenCalledWith('project_task_raci', 'r1')
    expect(create).toHaveBeenCalledWith('project_task_raci', { task_id: 't2', user_id: 'u9', role: 'R' })
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0])
    expect(screen.getByTestId('raci-cell-t2-u9')).toHaveTextContent('R')
  })

  it('A second accountable is accepted and listed in a warning on top.', async () => {
    const { ops, create } = opsFixture({ tasks: RACI_TASKS, members: RACI_MEMBERS, raci: RACI_ROWS })
    renderRenderer(ops)
    fireEvent.click(await screen.findByRole('tab', { name: 'RACI' }))
    fireEvent.click(await screen.findByTestId('raci-cell-t2-u2'))
    expect(screen.queryByTestId('raci-multi-accountable')).toBeNull()
    fireEvent.click(within(screen.getByRole('menu')).getByText('A'))
    await act(async () => {})
    expect(create).toHaveBeenCalledWith('project_task_raci', { task_id: 't2', user_id: 'u2', role: 'A' })
    expect(screen.getByTestId('raci-multi-accountable')).toHaveTextContent('Task t2')
  })

  it('Bulk edit sets one person\'s roles on every ticked row.', async () => {
    const { ops, create } = opsFixture({ tasks: RACI_TASKS, members: RACI_MEMBERS, raci: RACI_ROWS })
    renderRenderer(ops)
    fireEvent.click(await screen.findByRole('tab', { name: 'RACI' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Bulk edit' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Task t1' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Task t3' }))
    fireEvent.mouseDown(within(screen.getByTestId('raci-bulk-user').parentElement!).getByRole('combobox'))
    fireEvent.click(within(screen.getByRole('listbox')).getByText('member'))
    fireEvent.mouseDown(within(screen.getByTestId('raci-bulk-roles').parentElement!).getByRole('combobox'))
    fireEvent.click(within(screen.getByRole('listbox')).getByText('I'))
    fireEvent.click(screen.getByRole('button', { name: 'Apply (2)' }))
    await act(async () => {})
    expect(create).toHaveBeenCalledWith('project_task_raci', { task_id: 't1', user_id: 'u2', role: 'I' })
    expect(create).toHaveBeenCalledWith('project_task_raci', { task_id: 't3', user_id: 'u2', role: 'I' })
    expect(screen.getByTestId('raci-cell-t3-u2').textContent).toBe('I')
    expect(screen.getByTestId('raci-cell-t2-u2').textContent).toBe('')
  })

  it('shows long task and people names in full, on screen and in the PNG/PDF export', async () => {
    const long = 'A very long task title that goes well past the forty character cap'
    const { ops } = opsFixture({ tasks: [task('t1', { name: long })], members: RACI_MEMBERS })
    renderRenderer(ops)
    fireEvent.click(await screen.findByRole('tab', { name: 'RACI' }))
    expect((await screen.findByTestId('raci-name-t1')).textContent).toBe(long)

    let captured = ''
    vi.mocked(exportElementPng).mockImplementation(async (el) => {
      captured = el.querySelector('[data-testid="raci-name-t1"]')!.textContent ?? ''
    })
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export PNG' }))
    await vi.waitFor(() => expect(exportElementPng).toHaveBeenCalledWith(expect.any(HTMLTableElement), 'raci-p1', expect.any(String)))
    expect(captured).toBe(long)

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export PDF' }))
    await vi.waitFor(() =>
      expect(exportElementPdf).toHaveBeenCalledWith(expect.any(HTMLTableElement), expect.objectContaining({ title: 'Acme — RACI' }), 'raci-p1'),
    )
  })

  it('Read-only users see letters only.', async () => {
    canWriteRaci.value = false
    const { ops } = opsFixture({ tasks: RACI_TASKS, members: RACI_MEMBERS, raci: RACI_ROWS })
    renderRenderer(ops)
    fireEvent.click(await screen.findByRole('tab', { name: 'RACI' }))
    await screen.findByTestId('raci-cell-t2-u9')
    // The letters render, but the grid has no buttons at all.
    expect(screen.getByTestId('raci-cell-t2-u9').textContent).toBe('A')
    expect(screen.getByTestId('raci-grid').querySelector('button')).toBeNull()
    // Tapping does nothing.
    fireEvent.click(screen.getByTestId('raci-cell-t2-u9'))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('On phone the grid becomes a per-task card listing `R: …, A: …, C: …, I: …`, and an `Edit` button opens a dialog with one select per person.', async () => {
    setViewportWidth(390)
    const { ops, update } = opsFixture({ tasks: RACI_TASKS, members: RACI_MEMBERS, raci: RACI_ROWS })
    renderRenderer(ops)
    fireEvent.click(await screen.findByRole('tab', { name: 'RACI' }))
    const card = await screen.findByTestId('raci-card-t2')
    expect(within(card).getByText('R: –')).toBeInTheDocument()
    expect(within(card).getByText('A: holder')).toBeInTheDocument()
    expect(within(card).getByText('C: –')).toBeInTheDocument()
    expect(within(card).getByText('I: –')).toBeInTheDocument()

    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByRole('combobox')).toHaveLength(4) // one roles select per person
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    fireEvent.mouseDown(within(dialog).getByRole('combobox', { name: 'holder' }))
    expect(screen.getByRole('listbox')).not.toHaveAttribute('aria-multiselectable', 'true')
    fireEvent.click(within(screen.getByRole('listbox')).getByText('R'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await act(async () => {})
    expect(update).toHaveBeenCalledWith('project_task_raci', 'r1', { role: 'R' })
    expect(within(card).getByText('R: holder')).toBeInTheDocument()
    expect(within(card).getByText('A: –')).toBeInTheDocument()
  })
})

describe('MatrixRenderer RACI task tree', () => {
  // P (1) > A (1.1), B (1.2) > B1 (1.2.1); Q (2) stands alone.
  const TREE = [
    task('P', { wbs_number: '1' }),
    task('A', { wbs_number: '1.1', parent_id: 'P' }),
    task('B', { wbs_number: '1.2', parent_id: 'P' }),
    task('B1', { wbs_number: '1.2.1', parent_id: 'B' }),
    task('Q', { wbs_number: '2' }),
  ]
  const ROWS = [
    { id: 'r1', task_id: 'A', user_id: 'u2', role: 'R' },
    { id: 'r2', task_id: 'B1', user_id: 'u2', role: 'A' },
    { id: 'r3', task_id: 'A', user_id: 'u3', role: 'A' },
  ]
  const CONFIG = { ...BASE_CONFIG, parentField: 'parent_id' }
  const rowIds = () => [
    ...new Set(
      within(screen.getByTestId('raci-grid'))
        .getAllByTestId(/^raci-cell-/)
        .map((el) => (el.getAttribute('data-testid') ?? '').replace('raci-cell-', '').split('-')[0]),
    ),
  ]
  const open = async (raci = ROWS) => {
    const fx = opsFixture({ tasks: TREE, members: [{ id: 'pm2', user_id: 'u2' }, { id: 'pm3', user_id: 'u3' }], raci })
    renderRenderer(fx.ops, CONFIG)
    fireEvent.click(await screen.findByRole('tab', { name: 'RACI' }))
    await screen.findByTestId('raci-cell-P-u2')
    return fx
  }

  beforeEach(() => {
    setViewportWidth(1280)
    canWriteRaci.value = true
  })
  afterEach(() => cleanup())

  it('computes a parent cell from its subtasks, muted, without warning about the summed accountables', async () => {
    await open()
    expect(screen.getByTestId('raci-cell-B-u2').textContent).toBe('A')
    expect(screen.getByTestId('raci-cell-P-u2').textContent).toBe('R/A')
    expect(screen.getByTestId('raci-cell-P-u2')).toHaveAttribute('data-computed', 'true')
    expect(screen.getByTestId('raci-cell-A-u2')).not.toHaveAttribute('data-computed')
    // u2 and u3 are both A under P, computed: no "several accountable" warning.
    expect(screen.getByTestId('raci-cell-P-u3').textContent).toBe('A')
    expect(screen.queryByTestId('raci-multi-accountable')).toBeNull()
    expect(screen.getByTestId('raci-row-P')).not.toHaveTextContent('No one accountable')
  })

  it('a hand-set parent cell wins; ticking a computed one writes its roles, and "Use computed values" goes back', async () => {
    const { create, remove } = await open()
    fireEvent.click(screen.getByTestId('raci-cell-P-u2'))
    expect(within(screen.getByRole('menu')).queryByText('Use computed values')).toBeNull()
    fireEvent.click(within(screen.getByRole('menu')).getByText('C'))
    await act(async () => {})
    expect(create.mock.calls.map((c) => c[1])).toEqual([
      { task_id: 'P', user_id: 'u2', role: 'C' },
    ])
    expect(screen.getByTestId('raci-cell-P-u2').textContent).toBe('C')
    expect(screen.getByTestId('raci-cell-P-u2')).not.toHaveAttribute('data-computed')
    fireEvent.click(within(screen.getByRole('menu')).getByText('Use computed values'))
    await act(async () => {})
    expect(remove).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('raci-cell-P-u2').textContent).toBe('R/A')
    expect(screen.getByTestId('raci-cell-P-u2')).toHaveAttribute('data-computed', 'true')
  })

  it('stored parent rows show as they are', async () => {
    await open([...ROWS, { id: 'r9', task_id: 'P', user_id: 'u2', role: 'I' }])
    expect(screen.getByTestId('raci-cell-P-u2').textContent).toBe('I')
  })

  it('collapses a branch with its chevron and filters on a parent task', async () => {
    await open()
    expect(rowIds()).toEqual(['P', 'A', 'B', 'B1', 'Q'])
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Task B' }))
    expect(rowIds()).toEqual(['P', 'A', 'B', 'Q'])
    expect(screen.getByRole('button', { name: 'Expand Task B' })).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Task P' }))
    expect(rowIds()).toEqual(['P', 'Q'])
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(rowIds()).toEqual(['P', 'A', 'B', 'B1', 'Q'])
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(rowIds()).toEqual(['P', 'Q'])
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Parent task' }))
    fireEvent.click(within(screen.getByRole('listbox')).getByText('1.2 Task B'))
    expect(rowIds()).toEqual(['B', 'B1'])
    // The picked parent stays shown even when a branch above it is collapsed.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Task B' }))
    expect(rowIds()).toEqual(['B'])
  })

  it('without parentField there is no tree', async () => {
    const fx = opsFixture({ tasks: TREE, raci: ROWS })
    renderRenderer(fx.ops)
    fireEvent.click(await screen.findByRole('tab', { name: 'RACI' }))
    await screen.findByTestId('raci-cell-P-u2')
    expect(screen.queryByRole('combobox', { name: 'Parent task' })).toBeNull()
    expect(screen.getByTestId('raci-cell-P-u2').textContent).toBe('')
  })

  it('on phone a card marks computed people and collapses too', async () => {
    setViewportWidth(390)
    const fx = opsFixture({ tasks: TREE, members: [{ id: 'pm2', user_id: 'u2' }], raci: ROWS })
    renderRenderer(fx.ops, CONFIG)
    fireEvent.click(await screen.findByRole('tab', { name: 'RACI' }))
    const card = await screen.findByTestId('raci-card-P')
    expect(card).toHaveTextContent('A: member*')
    expect(card).toHaveTextContent('* Computed from subtasks')
    fireEvent.click(within(card).getByRole('button', { name: 'Collapse Task P' }))
    expect(screen.queryByTestId('raci-card-A')).toBeNull()
  })
})

describe('humanDeadline', () => {
  const now = new Date(2026, 5, 15, 10, 0)
  it('says the day relative to today, then the date', () => {
    expect(humanDeadline(new Date(2026, 5, 16).toISOString(), now, 'en')).toMatch(/^tomorrow · Jun 16, 2026$/)
    expect(humanDeadline(new Date(2026, 5, 13).toISOString(), now, 'en')).toMatch(/^2 days ago · /)
  })
  it('adds the time when not midnight, keeps garbage as is', () => {
    expect(humanDeadline(new Date(2026, 5, 18, 14, 30).toISOString(), now, 'en')).toMatch(/^in 3 days · Jun 18, 2026, 2:30\s?PM$/)
    expect(humanDeadline('nope', now, 'en')).toBe('nope')
  })
})
