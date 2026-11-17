import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

// next/navigation: the page guard (notFound/redirect) plus the week param and
// the router replace used by Previous/Next week.
const notFound = vi.fn(() => { throw new Error('NOT_FOUND') })
const redirect = vi.fn((url: string) => { throw new Error(`REDIRECT ${url}`) })
const pathnameMock = vi.fn(() => '/app/project/timesheet-week')
const routerReplace = vi.fn()
const searchParams = vi.hoisted(() => ({ value: '' }))
vi.mock('next/navigation', () => ({
  notFound: () => notFound(),
  redirect: (u: string) => redirect(u),
  usePathname: () => pathnameMock(),
  useRouter: () => ({ push: vi.fn(), replace: (...a: unknown[]) => routerReplace(...a), refresh: vi.fn(), prefetch: () => {}, back: vi.fn(), forward: vi.fn() }),
  useSearchParams: () => new URLSearchParams(searchParams.value),
}))
const identity = vi.hoisted(() => ({
  userId: 'ada',
  tenantId: 't1',
  roles: [],
  permissions: ['project_task:project_task:read', 'project_timesheet:project_timesheet:read', 'project:project:read'],
}))
const requireAuth = vi.fn(async () => identity)
vi.mock('@/lib/session', () => ({ requireAuth: () => requireAuth() }))
const activeModules = vi.hoisted(() => ({ value: new Set(['project']) }))
vi.mock('@/lib/module-state', () => ({ activeModuleNames: async () => activeModules.value }))
// The relation-actions layer: the page's only data path (no BFF route).
const listRecords = vi.fn()
const getRecord = vi.fn()
const createRecord = vi.fn()
const updateRecord = vi.fn()
const removeRecord = vi.fn()
vi.mock('@/lib/relation-actions', () => ({
  listRecords: (...a: unknown[]) => listRecords(...a),
  getRecord: (...a: unknown[]) => getRecord(...a),
  createRelationRecord: (...a: unknown[]) => createRecord(...a),
  updateRelationRecord: (...a: unknown[]) => updateRecord(...a),
  removeRelationRecord: (...a: unknown[]) => removeRecord(...a),
}))

import { TimesheetWeek } from './TimesheetWeek'
import TimesheetWeekPage from '../../app/app/project/timesheet-week/page'

type Options = {
  filter?: Record<string, string>
  order?: string
  page?: number
  pageSize?: number
  gte?: Record<string, string>
  lt?: Record<string, string>
  search?: Record<string, string>
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
type EntryRow = { id: string; task_id: string; user_id: string; date: string; hours: number }
type TaskRow = { id: string; name: string; [k: string]: unknown }
const entry = (id: string, task_id: string, date: string, hours: number): EntryRow => ({ id, task_id, user_id: 'ada', date, hours })
const task = (id: string, name: string, over: Record<string, unknown> = {}): TaskRow => ({
  id, name, project_id: 'p1', deadline: null, spent_hours: 0, ...over,
})

/** A write the server refuses (403, e.g. someone else's line): the settle
 * ActionError shape unwrapActionResult turns back into a thrown ApiError. */
const refused = () => ({ __eerpActionError: { code: 'FORBIDDEN', message: 'refused by the server', status: 403 } })

/** Stub the two list reads the grid performs: my week's entries (filtered by
 * the gte/lt date range) and my open assigned tasks; plus the Add task
 * search results. */
function stubWeek(entries: EntryRow[], tasks: TaskRow[], searchResults: Record<string, TaskRow[]> = {}) {
  listRecords.mockImplementation(async (entity: string, options?: Options) => {
    if (entity === 'project_timesheet') {
      const gte = options?.gte?.date ?? ''
      const lt = options?.lt?.date ?? ''
      return entries.filter((e) => e.user_id === options?.filter?.user_id && e.date >= gte && e.date < lt)
    }
    if (entity === 'project_task') {
      if (options?.search?.name !== undefined) return searchResults[options.search.name] ?? []
      return tasks
    }
    return []
  })
}

beforeEach(() => {
  for (const fn of [listRecords, getRecord, createRecord, updateRecord, removeRecord]) fn.mockReset()
  activeModules.value = new Set(['project'])
  pathnameMock.mockReturnValue('/app/project/timesheet-week')
  searchParams.value = ''
  routerReplace.mockReset()
  stubWeek([], [])
})

describe('TimesheetWeek', () => {
  it('shows a Mon–Sun grid of my logged tasks plus my open tasks, with row, column and grand totals', async () => {
    stubWeek(
      [
        entry('e1', 't1', w(0), 2), // Mon
        entry('e2', 't1', w(1), 3), // Tue
        entry('e3', 't2', w(2), 4), // Wed
        entry('e4', 't1', w(2), 1.5),
        entry('e5', 't1', w(2), 2),
      ],
      [task('t1', 'Alpha'), task('t2', 'Beta'), task('t3', 'Gamma')],
    )
    render(<TimesheetWeek userId="ada" />)
    await screen.findByRole('columnheader', { name: 'Mon' }) // the grid is loaded
    for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
      expect(screen.getByRole('columnheader', { name: day }), day).toBeInTheDocument()
    }
    // Logged tasks keep their cells; the untouched open task is still a row.
    const alpha = await screen.findByRole('row', { name: 'Alpha' })
    expect(within(alpha).getByRole('spinbutton', { name: 'Alpha Mon' })).toHaveValue('2')
    expect(within(alpha).getByRole('spinbutton', { name: 'Alpha Tue' })).toHaveValue('3')
    expect(within(alpha).queryByRole('spinbutton', { name: 'Alpha Wed' })).toBeNull() // several entries: read-only
    expect(within(alpha).getByText('3.5')).toBeInTheDocument()
    expect(within(alpha).getByText('8.5')).toBeInTheDocument() // row total 2 + 3 + 3.5
    const beta = screen.getByRole('row', { name: 'Beta' })
    expect(within(beta).getByRole('spinbutton', { name: 'Beta Wed' })).toHaveValue('4')
    expect(within(beta).getByText('4')).toBeInTheDocument()
    const gamma = screen.getByRole('row', { name: 'Gamma' })
    expect(within(gamma).getByRole('spinbutton', { name: 'Gamma Mon' })).toHaveValue('')
    // Column and grand totals.
    const totals = screen.getByRole('row', { name: 'Totals' })
    expect(within(totals).getAllByText('7.5').length).toBeGreaterThan(0) // Wed column 4 + 3.5
    expect(within(totals).getByText('12.5')).toBeInTheDocument() // grand total
    // The two reads the page performs.
    expect(listRecords).toHaveBeenCalledWith(
      'project_timesheet',
      expect.objectContaining({ filter: { user_id: 'ada' }, gte: { date: w(0) }, lt: { date: w(7) } }),
    )
    expect(listRecords).toHaveBeenCalledWith(
      'project_task',
      expect.objectContaining({ filter: { assignee: 'me', closed: 'false' }, order: 'name' }),
    )
  })

  it('empty cells create an entry, single-entry cells update it, and 0 deletes it', async () => {
    stubWeek(
      [entry('e1', 't1', w(0), 2), entry('e2', 't1', w(1), 3)],
      [task('t1', 'Alpha')],
    )
    render(<TimesheetWeek userId="ada" />)
    // Empty cell: typing hours and leaving the cell creates the entry.
    const mon = await screen.findByRole('spinbutton', { name: 'Alpha Mon' })
    const thu = screen.getByRole('spinbutton', { name: 'Alpha Thu' })
    fireEvent.change(thu, { target: { value: '1.5' } })
    fireEvent.blur(thu)
    await waitFor(() => expect(createRecord).toHaveBeenCalledWith('project_timesheet', { task_id: 't1', date: w(3), hours: 1.5 }))
    // Single-entry cell: the new hours update that one entry.
    fireEvent.change(mon, { target: { value: '5' } })
    fireEvent.blur(mon)
    await waitFor(() => expect(updateRecord).toHaveBeenCalledWith('project_timesheet', 'e1', { hours: 5 }))
    // A zero hour value deletes the (single) entry.
    const tue = screen.getByRole('spinbutton', { name: 'Alpha Tue' })
    fireEvent.change(tue, { target: { value: '0' } })
    fireEvent.blur(tue)
    await waitFor(() => expect(removeRecord).toHaveBeenCalledWith('project_timesheet', 'e2'))
  })

  it('a cell holding several entries is read-only with a tooltip pointing to Timesheets', async () => {
    // Alpha logs two entries on Wednesday (3.5); the other values in the grid
    // (row total 5.5, Wednesday column 4.5, grand total 6.5) keep '3.5' unique.
    stubWeek(
      [entry('e1', 't1', w(2), 1.5), entry('e2', 't1', w(2), 2), entry('e3', 't1', w(0), 2), entry('e4', 't2', w(2), 1)],
      [task('t1', 'Alpha'), task('t2', 'Beta')],
    )
    render(<TimesheetWeek userId="ada" />)
    const cell = await screen.findByText('3.5')
    expect(screen.queryByRole('spinbutton', { name: 'Alpha Wed' })).toBeNull()
    fireEvent.mouseOver(cell)
    expect(await screen.findByText('Several entries: edit them in Timesheets')).toBeInTheDocument()
  })

  it('a refused write restores the cell and shows the error', async () => {
    stubWeek([entry('e1', 't1', w(0), 2)], [task('t1', 'Alpha')])
    updateRecord.mockResolvedValue(refused())
    render(<TimesheetWeek userId="ada" />)
    const mon = await screen.findByRole('spinbutton', { name: 'Alpha Mon' })
    fireEvent.change(mon, { target: { value: '9' } })
    fireEvent.blur(mon)
    await waitFor(() => expect(updateRecord).toHaveBeenCalledWith('project_timesheet', 'e1', { hours: 9 }))
    expect(mon).toHaveValue('2') // restored
    expect(screen.getByText('refused by the server')).toBeInTheDocument()
  })

  it('Previous/Next week move the grid a week and keep the URL in sync', async () => {
    stubWeek(
      [entry('e1', 't1', w(0), 2)],
      [task('t1', 'Alpha')],
    )
    render(<TimesheetWeek userId="ada" />)
    await screen.findByRole('spinbutton', { name: 'Alpha Mon' })
    expect(screen.getByText(`${w(0)} – ${w(6)}`)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }))
    expect(routerReplace).toHaveBeenCalledWith(`/app/project/timesheet-week?week=${w(7)}`)
    expect(await screen.findByText(`${w(7)} – ${w(13)}`)).toBeInTheDocument()
    // The entries of the new week were re-read for that range (none here).
    expect(listRecords).toHaveBeenCalledWith(
      'project_timesheet',
      expect.objectContaining({ filter: { user_id: 'ada' }, gte: { date: w(7) }, lt: { date: w(14) } }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }))
    expect(routerReplace).toHaveBeenCalledWith(`/app/project/timesheet-week?week=${w(0)}`)
    expect(await screen.findByText(`${w(0)} – ${w(6)}`)).toBeInTheDocument()
    // An explicit ?week= param selects that week.
    searchParams.value = `week=${w(14)}`
    render(<TimesheetWeek userId="ada" />)
    await screen.findByRole('spinbutton', { name: 'Alpha Mon' })
    expect(listRecords).toHaveBeenCalledWith(
      'project_timesheet',
      expect.objectContaining({ gte: { date: w(14) }, lt: { date: w(21) } }),
    )
  })

  it('Add task searches my visible open tasks and appends a row', async () => {
    stubWeek(
      [entry('e1', 't1', w(0), 2)],
      [task('t1', 'Alpha')],
      { Delta: [task('t4', 'Delta')] },
    )
    render(<TimesheetWeek userId="ada" />)
    await screen.findByRole('spinbutton', { name: 'Alpha Mon' })
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
    const search = screen.getByLabelText('Search tasks')
    fireEvent.change(search, { target: { value: 'Delta' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() =>
      expect(listRecords).toHaveBeenCalledWith(
        'project_task',
        expect.objectContaining({ filter: { closed: 'false' }, search: { name: 'Delta' }, order: 'name' }),
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delta' }))
    const delta = await screen.findByRole('row', { name: 'Delta' })
    expect(within(delta).getByRole('spinbutton', { name: 'Delta Mon' })).toHaveValue('')
    // A search with no hit says so.
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }))
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'zzz' } })
    fireEvent.keyDown(screen.getByLabelText('Search tasks'), { key: 'Enter' })
    expect(await screen.findByText('No matching tasks')).toBeInTheDocument()
  })

  it('the page is a 404 while the project module is inactive', async () => {
    activeModules.value = new Set()
    await expect(TimesheetWeekPage()).rejects.toThrow('NOT_FOUND')
  })

  it('the page renders the weekly grid for a signed-in user', async () => {
    stubWeek([], [task('t1', 'Alpha')])
    render(await TimesheetWeekPage())
    expect(await screen.findByRole('heading', { name: 'Timesheet week' })).toBeInTheDocument()
    expect(await screen.findByRole('row', { name: 'Alpha' })).toBeInTheDocument()
  })

  it('at 390px it shows one day at a time: day tabs with totals and task rows with number inputs', async () => {
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
      stubWeek(
        [
          entry('e1', 't1', w(0), 2), // Mon
          entry('e2', 't2', w(2), 4), // Wed
          entry('e3', 't1', w(2), 1.5),
          entry('e4', 't1', w(2), 2),
        ],
        [task('t1', 'Alpha'), task('t2', 'Beta')],
      )
      render(<TimesheetWeek userId="ada" />)
      await screen.findByRole('tab', { name: 'Mon 2' }) // the day tabs are loaded
      for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
        expect(screen.queryByRole('tab', { name: new RegExp(`^${day}\\b`) }), day).toBeTruthy()
      }
      expect(screen.getByRole('tab', { name: 'Mon 2' })).toHaveAttribute('aria-selected', 'true')
      const alpha = await screen.findByRole('article', { name: 'Alpha' })
      expect(within(alpha).getByRole('spinbutton', { name: 'Alpha Mon' })).toHaveValue('2')
      expect(within(screen.getByRole('article', { name: 'Beta' })).getByRole('spinbutton', { name: 'Beta Mon' })).toHaveValue('')
      // Switch to Wednesday: the day total moved with the tab, the cells do too.
      fireEvent.click(screen.getByRole('tab', { name: 'Wed 7.5' }))
      expect(screen.getByRole('tab', { name: 'Wed 7.5' })).toHaveAttribute('aria-selected', 'true')
      const alphaWed = await screen.findByRole('article', { name: 'Alpha' })
      // Alpha's Wednesday holds two entries: read-only sum, no input.
      expect(within(alphaWed).queryByRole('spinbutton', { name: 'Alpha Wed' })).toBeNull()
      expect(within(alphaWed).getByText('3.5')).toBeInTheDocument()
      expect(within(screen.getByRole('article', { name: 'Beta' })).getByRole('spinbutton', { name: 'Beta Wed' })).toHaveValue('4')
    } finally {
      window.matchMedia = real
    }
  })
})
