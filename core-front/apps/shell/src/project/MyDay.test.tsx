import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ModuleRegistry, useSessionStore } from '@eerp/core-front'

// next/navigation: the page guard (notFound/redirect) plus the top bar's
// own pathname/router reads.
const notFound = vi.fn(() => { throw new Error('NOT_FOUND') })
const redirect = vi.fn((url: string) => { throw new Error(`REDIRECT ${url}`) })
const pathnameMock = vi.fn(() => '/app/project/my-day')
vi.mock('next/navigation', () => ({
  notFound: () => notFound(),
  redirect: (u: string) => redirect(u),
  usePathname: () => pathnameMock(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: () => {}, back: vi.fn(), forward: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
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

import { MyDay } from './MyDay'
import MyDayPage from '../../app/app/project/my-day/page'
import { AppTopBar } from '../components/AppTopBar'
import projectModule from '../../../../../core/modules/project/views/project_views'

type Options = { filter?: Record<string, string>; order?: string; page?: number; pageSize?: number }

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const dayOffset = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return iso(d) }
const task = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, project_id: 'p1', stage_id: 's1', deadline: null, spent_hours: 0, ...over,
})

/** Stub the two list reads My day performs: my open tasks, and the closed
 * stages per project (keyed by project id). */
function stubMyDay(tasks: Record<string, unknown>[], stagesByProject: Record<string, Record<string, unknown>[]> = {}) {
  listRecords.mockImplementation(async (entity: string, options?: Options) => {
    if (entity === 'project_task') return tasks
    if (entity === 'project_stage') return stagesByProject[options?.filter?.project_id ?? ''] ?? []
    return []
  })
}

beforeEach(() => {
  for (const fn of [listRecords, getRecord, createRecord, updateRecord, removeRecord]) fn.mockReset()
  activeModules.value = new Set(['project'])
  pathnameMock.mockReturnValue('/app/project/my-day')
  stubMyDay([])
})

describe('MyDay', () => {
  it('groups my open assigned tasks into Overdue, Today, This week, Later and No deadline', async () => {
    stubMyDay([
      task('t-late', { deadline: dayOffset(-1) }),
      task('t-today', { deadline: dayOffset(0) }),
      task('t-week', { deadline: dayOffset(3) }),
      task('t-later', { deadline: dayOffset(30) }),
      task('t-none', { deadline: null }),
    ])
    render(<MyDay />)
    const groups: [string, string][] = [
      ['Overdue', 't-late'],
      ['Today', 't-today'],
      ['This week', 't-week'],
      ['Later', 't-later'],
      ['No deadline', 't-none'],
    ]
    for (const [group, id] of groups) {
      const region = await screen.findByRole('region', { name: group })
      expect(within(region).getByRole('row', { name: id }), group).toBeTruthy()
    }
    expect(listRecords).toHaveBeenCalledWith(
      'project_task',
      expect.objectContaining({ filter: { assignee: 'me', closed: 'false' }, order: 'deadline' }),
    )
  })

  it('Log time opens a dialog defaulting to 1 hour today, logs the entry and refreshes the row', async () => {
    stubMyDay([task('t1', { deadline: dayOffset(2), spent_hours: 1 })])
    createRecord.mockResolvedValue({ id: 'e1', task_id: 't1', hours: 2, date: dayOffset(0) })
    getRecord.mockResolvedValue(task('t1', { deadline: dayOffset(2), spent_hours: 3 }))
    render(<MyDay />)
    fireEvent.click(await screen.findByRole('button', { name: 'Log time' }))
    const hours = screen.getByRole('spinbutton', { name: 'Hours' })
    expect(hours).toHaveValue('1')
    expect(screen.getByLabelText('Date')).toHaveValue(dayOffset(0))
    fireEvent.change(hours, { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Log' }))
    await waitFor(() => expect(createRecord).toHaveBeenCalledWith('project_timesheet', { task_id: 't1', hours: 2, date: dayOffset(0) }))
    // The row's spent hours come from the re-read task (the trigger recomputed them).
    await waitFor(() => expect(within(screen.getByRole('row', { name: 't1' })).getByText('3')).toBeInTheDocument())
  })

  it("Done moves the task to its project's first closed stage, hidden when none exists", async () => {
    stubMyDay(
      [task('t1', { project_id: 'p1', deadline: dayOffset(1) }), task('t2', { project_id: 'p2', deadline: dayOffset(1) })],
      { p1: [{ id: 's1', name: 'Done', sequence: 10 }], p2: [] },
    )
    updateRecord.mockResolvedValue(task('t1', { project_id: 'p1', stage_id: 's1' }))
    render(<MyDay />)
    await screen.findByRole('button', { name: 'Done' })
    expect(listRecords).toHaveBeenCalledWith(
      'project_stage',
      expect.objectContaining({ filter: { project_id: 'p1', closed: 'true' }, order: 'sequence' }),
    )
    // Only t1's project has a closed stage: exactly one Done button.
    expect(screen.getAllByRole('button', { name: 'Done' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(updateRecord).toHaveBeenCalledWith('project_task', 't1', { stage_id: 's1' }))
    // The task just closed: its row leaves the page.
    await waitFor(() => expect(screen.queryByRole('row', { name: 't1' })).not.toBeInTheDocument())
  })

  it('the page is a 404 while the project module is inactive', async () => {
    activeModules.value = new Set()
    await expect(MyDayPage()).rejects.toThrow('NOT_FOUND')
  })

  it('the page renders the My day view for a signed-in user', async () => {
    stubMyDay([])
    render(await MyDayPage())
    expect(await screen.findByRole('heading', { name: 'My day' })).toBeInTheDocument()
    expect(screen.getByText('No open tasks')).toBeInTheDocument()
  })

  it('the top bar shows the Project menus on /project/my-day', async () => {
    const registry = new ModuleRegistry()
    registry.register(projectModule, { appMode: true })
    useSessionStore.getState().setIdentity(identity)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    render(<AppTopBar identity={identity} headerMenus={registry.headerMenus()} />)
    const nav = screen.getByRole('navigation', { name: 'module pages' })
    fireEvent.click(within(nav).getByRole('button', { name: 'Planning' }))
    expect(await screen.findByRole('menuitem', { name: 'My day' })).toBeInTheDocument()
    vi.unstubAllGlobals()
  })

  it('at 390px the rows are full-width cards with 40px buttons', async () => {
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
      stubMyDay([task('t1', { deadline: dayOffset(2) })])
      render(<MyDay />)
      const card = await screen.findByRole('article', { name: 't1' })
      expect(card).toHaveStyle({ width: '100%' })
      expect(screen.getByRole('button', { name: 'Log time' })).toHaveStyle({ minHeight: '40px' })
    } finally {
      window.matchMedia = real
    }
  })
})
