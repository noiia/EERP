import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { MatrixConfig } from '../../api/view-fields'
import { ApiError } from '../../api/errors'
import { RelationOpsProvider, type RelationOps } from '../relation-ops'
import { setViewportWidth } from '../../test/viewport'
import { MatrixRenderer, type MatrixTask } from './matrix-renderer'

const push = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

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
  userLabelField: 'email',
  dependencies: { entity: 'project_task_dependency', fromField: 'depends_on_id', toField: 'task_id' },
  priorityField: 'priority',
  deadlineField: 'deadline',
  closedField: 'closed',
  urgentDays: 7,
  taskEntity: 'project_task',
  taskFormPath: '/project/tasks/:id',
}

const USERS = [
  { id: 'm1', email: 'manager@ex.com' },
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
