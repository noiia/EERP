import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

const exportElementPng = vi.hoisted(() => vi.fn<(el: HTMLElement, name: string, bg?: string) => Promise<void>>(async () => {}))
const exportElementPdf = vi.hoisted(() => vi.fn<(el: HTMLElement, meta: unknown, name: string) => Promise<void>>(async () => {}))
vi.mock('./diagram/export', () => ({ exportElementPng, exportElementPdf }))

import { createTheme, ThemeProvider } from '@mui/material/styles'
import { GanttRenderer } from './gantt-renderer'
import { useUndoToastStore } from './undo-toast'
import type { ViewDescriptor } from './descriptor'
import type { EntityActions } from './stores'
import { RelationOpsProvider, type RelationOps } from './relation-ops'
import { BannerScope, BannerSlot } from './banner'
import { useSessionStore } from './session-store'
import { ApiError } from '../api/errors'
import { setViewportWidth } from '../test/viewport'
import type { EntityListOptions } from '../api/list-options'
import type { GanttBaselineConfig, GanttExchangeConfig, GanttMilestonesConfig, GanttScheduleConfig } from '../api/view-fields'
import { registerKanbanColumnsGuard } from './kanban-columns'

type Task = {
  id: string
  name: string
  date_start?: string | null
  deadline?: string | null
}

type ListPage = NonNullable<RelationOps['listPage']>

const descriptor: ViewDescriptor<Task> = {
  entity: 'task',
  viewType: 'tree',
  formPath: '/tasks/:id',
  fields: [
    { name: 'name', label: 'Name', type: 'text' },
    { name: 'date_start', label: 'Start', type: 'date' },
    { name: 'deadline', label: 'Deadline', type: 'date' },
  ],
}

// Wednesday 2026-03-04: the default (week) range starts on Monday 2026-03-02.
const TODAY = new Date(2026, 2, 4, 12, 0, 0)

const alpha: Task = { id: '1', name: 'Alpha', date_start: '2026-03-02', deadline: '2026-03-08' }
const beta: Task = { id: '2', name: 'Beta', date_start: null, deadline: '2026-03-05' }

function grant(write: boolean) {
  useSessionStore.setState({
    identity: { userId: 'u1', tenantId: 't1', roles: [], permissions: write ? ['task:task:read', 'task:task:write'] : ['task:task:read'] },
  })
}

/** A 1400px track: 100px per day in Day zoom (14 days). */
function sizeTrack() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 1400, height: 20, top: 0, left: 0, right: 1400, bottom: 20, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect)
}

function drag(target: HTMLElement, dx: number) {
  fireEvent.pointerDown(target, { clientX: 500, pointerId: 1 })
  fireEvent.pointerMove(window, { clientX: 500 + dx, pointerId: 1 })
  fireEvent.pointerUp(window, { clientX: 500 + dx, pointerId: 1 })
}

describe('GanttRenderer', () => {
  let update: ReturnType<typeof vi.fn<(id: string, body: Partial<Task>) => Promise<Task>>>
  let actions: EntityActions<Task>

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(TODAY)
    update = vi.fn(async (id: string, body: Partial<Task>) => ({ id, ...body }) as Task)
    actions = { create: vi.fn(async (b) => b as Task), update }
    pushMock.mockReset()
    grant(true)
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function renderGantt(data: Task[] = [alpha, beta], d: ViewDescriptor<Task> = descriptor) {
    return render(
      <GanttRenderer descriptor={d} initialData={data} actions={actions} startField="date_start" endField="deadline" />,
    )
  }

  describe('subtasks', () => {
    const tree: ViewDescriptor<Task> = { ...descriptor, viewModeDefaults: { wbsParentField: 'parent_id' } }
    const parent = { ...alpha, id: 'p', name: 'Parent' }
    const child = { ...alpha, id: 'c', name: 'Child', parent_id: 'p' } as Task
    const grandchild = { ...alpha, id: 'g', name: 'Grandchild', parent_id: 'c' } as Task

    it('folds a row\'s subtasks with its chevron, and Collapse all / Expand all toggle every parent', () => {
      renderGantt([grandchild, child, parent], tree)
      expect(screen.getByTestId('gantt-row-g')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Collapse Child' }))
      expect(screen.queryByTestId('gantt-row-g')).toBeNull()
      expect(screen.getByTestId('gantt-row-c')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
      expect(screen.getByTestId('gantt-row-g')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
      expect(screen.queryByTestId('gantt-row-c')).toBeNull()
      expect(screen.getByRole('button', { name: 'Expand Parent' })).toHaveAttribute('aria-expanded', 'false')
      // Kept for the session, like the zoom.
      cleanup()
      renderGantt([grandchild, child, parent], tree)
      expect(screen.queryByTestId('gantt-row-c')).toBeNull()
    })

    it('exports the timeline as drawn, folded rows left out, as PNG or PDF', async () => {
      renderGantt([grandchild, child, parent], tree)
      fireEvent.click(screen.getByRole('button', { name: 'Collapse Child' }))
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Export PNG' }))
      await waitFor(() => expect(exportElementPng).toHaveBeenCalledTimes(1))
      const [el, name] = exportElementPng.mock.calls[0]
      expect(within(el).getByText('Child')).toBeInTheDocument()
      expect(within(el).queryByText('Grandchild')).toBeNull()
      expect(name).toBe('Gantt 2026-03-02 – 2026-05-24')
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Export PDF' }))
      await waitFor(() => expect(exportElementPdf).toHaveBeenCalledWith(el, expect.objectContaining({ title: name }), name))
    })

    it('shows no chevron or toggle without a parent field', () => {
      renderGantt([child, parent])
      expect(screen.queryByRole('button', { name: 'Collapse all' })).toBeNull()
      expect(screen.getByTestId('gantt-row-c')).toBeInTheDocument()
    })
  })

  it('keeps the chosen zoom per entity for the session', () => {
    renderGantt()
    expect(screen.getByRole('button', { name: 'Week' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Month' }))
    cleanup()
    renderGantt()
    expect(screen.getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'true')
    cleanup()
    renderGantt([alpha, beta], { ...descriptor, entity: 'other' })
    expect(screen.getByRole('button', { name: 'Week' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('Shift + wheel moves the timeline a week per notch (a month in Month zoom)', () => {
    renderGantt()
    const grid = screen.getByTestId('gantt-track').parentElement!
    const range = () => screen.getByText(/–/).textContent
    const start = range()
    fireEvent.wheel(grid, { deltaY: 100, shiftKey: true })
    expect(range()).toBe(`${new Date(2026, 2, 9).toLocaleDateString()} – ${new Date(2026, 4, 31).toLocaleDateString()}`)
    fireEvent.wheel(grid, { deltaX: -100, shiftKey: true })
    expect(range()).toBe(start)
    // Small trackpad deltas add up; without Shift the wheel is left alone.
    fireEvent.wheel(grid, { deltaY: 60, shiftKey: true })
    expect(range()).toBe(start)
    fireEvent.wheel(grid, { deltaY: 500 })
    expect(range()).toBe(start)
    fireEvent.wheel(grid, { deltaY: 60, shiftKey: true })
    expect(range()).not.toBe(start)
    fireEvent.click(screen.getByRole('button', { name: 'Month' }))
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    fireEvent.wheel(grid, { deltaY: 100, shiftKey: true })
    expect(range()).toBe(`${new Date(2026, 3, 1).toLocaleDateString()} – ${new Date(2026, 8, 30).toLocaleDateString()}`)
  })

  it('the slider and a drag on the empty timeline move it by single days', () => {
    sizeTrack()
    renderGantt()
    fireEvent.click(screen.getByRole('button', { name: 'Day' })) // 100px per day
    const range = () => screen.getByText(/–/).textContent
    const slider = screen.getByRole('slider', { name: 'Timeline position' })
    fireEvent.change(slider, { target: { value: 3 } })
    expect(range()).toBe(`${new Date(2026, 2, 5).toLocaleDateString()} – ${new Date(2026, 2, 18).toLocaleDateString()}`)
    // Dragging the track 200px right shows two days earlier; no quick create on release.
    drag(screen.getByTestId('gantt-row-track-1'), 200)
    expect(range()).toBe(`${new Date(2026, 2, 3).toLocaleDateString()} – ${new Date(2026, 2, 16).toLocaleDateString()}`)
    // A drag on a bar moves the bar, not the timeline.
    drag(screen.getByTestId('gantt-bar-1'), 100)
    expect(range()).toBe(`${new Date(2026, 2, 3).toLocaleDateString()} – ${new Date(2026, 2, 16).toLocaleDateString()}`)
    expect(update).toHaveBeenCalledWith('1', { date_start: '2026-03-03', deadline: '2026-03-09' })
    // Month zoom over a mid-month start still draws its 8 lines per month inside the range.
    fireEvent.click(screen.getByRole('button', { name: 'Month' }))
    expect(range()).toBe(`${new Date(2026, 2, 1).toLocaleDateString()} – ${new Date(2026, 7, 31).toLocaleDateString()}`)
  })

  it('draws a grey line per day, or 8 per month in Month zoom', () => {
    renderGantt()
    const lines = () => screen.getByTestId('gantt-grid-lines').children
    expect(lines()).toHaveLength(83) // 12 weeks = 84 days, 83 inner boundaries
    fireEvent.click(screen.getByRole('button', { name: 'Day' }))
    expect(lines()).toHaveLength(13)
    fireEvent.click(screen.getByRole('button', { name: 'Month' }))
    expect(lines()).toHaveLength(6 * 8 - 1) // the range's left edge draws none
  })

  it('labels rows with the title field, not the layout\'s first field', () => {
    renderGantt([{ ...alpha, wbs_number: '1.2' } as Task], {
      ...descriptor,
      fields: [{ name: 'wbs_number', label: 'Order', type: 'text' }, ...descriptor.fields],
    })
    expect(within(screen.getByTestId('gantt-row-1')).getByRole('button', { name: 'Alpha' })).toBeInTheDocument()
  })

  it('labels rows "<order> - <name>" when the list has an order field', () => {
    renderGantt([{ ...alpha, wbs_number: '1.2' } as Task], {
      ...descriptor,
      fields: [{ name: 'wbs_number', label: 'Order', type: 'text' }, ...descriptor.fields],
      viewModeDefaults: { wbsOrderField: 'wbs_number' },
    })
    expect(within(screen.getByTestId('gantt-row-1')).getByRole('button', { name: '1.2 - Alpha' })).toBeInTheDocument()
  })

  it('marks today on the timeline only while today is in the visible range', () => {
    renderGantt()
    expect(screen.getByRole('img', { name: 'Today' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Day' }))
    // Day zoom: 14 days from Monday 2026-03-02, today (index 2) at the middle of its column.
    expect(parseFloat(screen.getByRole('img', { name: 'Today' }).style.left)).toBeCloseTo((2.5 / 14) * 100, 3)
    fireEvent.click(screen.getByRole('button', { name: 'Next period' }))
    expect(screen.queryByRole('img', { name: 'Today' })).toBeNull()
  })

  it('draws one row per scheduled record with a bar spanning its dates, the rest as Unscheduled', () => {
    renderGantt()
    fireEvent.click(screen.getByRole('button', { name: 'Day' }))
    expect(screen.getByTestId('gantt-row-1')).toHaveTextContent('Alpha')
    const bar = screen.getByTestId('gantt-bar-1')
    // 2026-03-02 → 2026-03-08 inclusive = 7 of the 14 visible days.
    expect(bar.style.left).toBe('0%')
    expect(bar.style.width).toBe('50%')
    expect(screen.queryByTestId('gantt-row-2')).toBeNull()
    expect(screen.getByRole('group', { name: 'Unscheduled' })).toHaveTextContent('Beta')
  })

  it('clips a bar to the visible range and hides records outside it', () => {
    renderGantt([alpha, { id: '3', name: 'Later', date_start: '2026-04-01', deadline: '2026-04-02' }])
    fireEvent.click(screen.getByRole('button', { name: 'Day' }))
    expect(screen.queryByTestId('gantt-row-3')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Previous period' }))
    expect(screen.queryByTestId('gantt-row-1')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    expect(screen.getByTestId('gantt-row-1')).toBeInTheDocument()
  })

  it('a label click opens the record form', () => {
    renderGantt()
    fireEvent.click(screen.getByText('Alpha'))
    expect(pushMock).toHaveBeenCalledWith('/app/tasks/1')
  })

  describe('phone', () => {
    const labels = () => within(screen.getByTestId('gantt-track')).getAllByText(/./).map((n) => n.textContent)

    it('shows 7 day columns in Day zoom on phone', () => {
      setViewportWidth(390)
      renderGantt()
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      expect(labels()).toHaveLength(7)
    })

    it('shows 6 week columns in Week zoom on phone', () => {
      setViewportWidth(390)
      renderGantt()
      expect(labels()).toHaveLength(6)
    })

    it('shows 3 months in Month zoom on phone', () => {
      setViewportWidth(390)
      renderGantt()
      fireEvent.click(screen.getByRole('button', { name: 'Month' }))
      expect(labels()).toHaveLength(3)
    })

    it('loads only the phone range', async () => {
      setViewportWidth(390)
      const listPage = vi.fn<ListPage>(async () => ({ records: [], total: 0 }))
      const ops = { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn(), listPage }
      render(
        <RelationOpsProvider ops={ops}>
          <GanttRenderer descriptor={descriptor} initialData={[]} actions={actions} startField="date_start" endField="deadline" serverOptions={{}} />
        </RelationOpsProvider>,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      await waitFor(() =>
        expect(listPage).toHaveBeenCalledWith('task', expect.objectContaining({ lt: { date_start: '2026-03-09' } })),
      )
    })

    it('Next moves by the phone span', () => {
      setViewportWidth(390)
      renderGantt()
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next period' }))
      expect(labels()[0]).toBe(new Date(2026, 2, 9).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }))
    })

    it('uses icon buttons and puts the range on its own line on phone', () => {
      setViewportWidth(390)
      renderGantt()
      const next = screen.getByRole('button', { name: 'Next period' })
      expect(next).toHaveTextContent('')
      expect(next.className).toContain('MuiIconButton')
      expect(getComputedStyle(next).width).toBe('40px')
      expect(screen.getByText(/–/)).toHaveStyle({ flexBasis: '100%' })
    })

    it('keeps zoom, Previous, Today and Next on one 312px line on phone (360px screen)', () => {
      setViewportWidth(360)
      renderGantt()
      const next = screen.getByRole('button', { name: 'Next period' })
      // 150px zoom + 40 + Today + 40 + 3 gaps must fit 312px: square 40px icons, 4px gaps.
      expect(next).toHaveStyle({ width: '40px', height: '40px', padding: '0px' })
      expect(screen.getByRole('button', { name: 'Previous period' })).toHaveStyle({ width: '40px' })
      expect(next.parentElement!).toHaveStyle({ gap: '4px' })
    })

    it('narrows the name column to 88px and clamps names to two lines', () => {
      setViewportWidth(390)
      renderGantt()
      expect(screen.getByTestId('gantt-track').parentElement!).toHaveStyle({ gridTemplateColumns: '88px minmax(0, 1fr)' })
      expect(within(screen.getByTestId('gantt-row-1')).getByText('Alpha')).toHaveStyle({ WebkitLineClamp: '2', lineHeight: '14px' })
      expect(within(screen.getByTestId('gantt-row-1')).getByText('Alpha').className).toContain('MuiTypography-caption')
    })

    it('gives bar edge handles a 16px touch area on phone', () => {
      setViewportWidth(390)
      renderGantt()
      expect(screen.getByTestId('gantt-handle-start-1')).toHaveStyle({ width: '16px' })
    })

    it('stacks Unscheduled below the timeline on phone', () => {
      setViewportWidth(390)
      renderGantt()
      expect(screen.getByRole('group', { name: 'Unscheduled' })).toHaveStyle({ width: '100%' })
      expect(screen.getByRole('group', { name: 'Unscheduled' }).closest('.MuiStack-root')).toHaveStyle({ flexDirection: 'column' })
    })

    it('keeps the desktop range when the viewport crosses back', () => {
      setViewportWidth(390)
      renderGantt()
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      fireEvent.click(screen.getByRole('button', { name: 'Next period' }))
      act(() => setViewportWidth(1280))
      expect(labels()).toHaveLength(14)
      expect(screen.getByRole('button', { name: 'Day' })).toHaveAttribute('aria-pressed', 'true')
      expect(labels()[0]).toBe(new Date(2026, 2, 9).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }))
    })
  })

  describe('server-loaded', () => {
    function serverRender(listPage: ListPage, serverOptions: EntityListOptions = {}) {
      const ops = { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn(), listPage }
      return render(
        <RelationOpsProvider ops={ops}>
          <GanttRenderer
            descriptor={descriptor}
            initialData={[]}
            actions={actions}
            startField="date_start"
            endField="deadline"
            serverOptions={serverOptions}
          />
        </RelationOpsProvider>,
      )
    }

    it('fetches only records overlapping the visible range, refetching on zoom and navigation', async () => {
      const listPage = vi.fn<ListPage>(async (_e: string, o?: EntityListOptions) =>
        o?.empty ? { records: [], total: 0 } : { records: [alpha], total: 1 },
      )
      serverRender(listPage, { filter: { project_id: 'p1' } })
      await waitFor(() =>
        expect(listPage).toHaveBeenCalledWith('task', expect.objectContaining({
          filter: { project_id: 'p1' },
          lt: { date_start: '2026-05-25' },
          gte: { deadline: '2026-03-02' },
          order: 'date_start',
        })),
      )
      expect(listPage).toHaveBeenCalledWith('task', expect.objectContaining({ empty: ['date_start'], filter: { project_id: 'p1' } }))
      expect(listPage).toHaveBeenCalledWith('task', expect.objectContaining({ empty: ['deadline'] }))

      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      await waitFor(() =>
        expect(listPage).toHaveBeenCalledWith('task', expect.objectContaining({
          lt: { date_start: '2026-03-16' }, gte: { deadline: '2026-03-02' },
        })),
      )
      fireEvent.click(screen.getByRole('button', { name: 'Next period' }))
      await waitFor(() =>
        expect(listPage).toHaveBeenCalledWith('task', expect.objectContaining({
          lt: { date_start: '2026-03-30' }, gte: { deadline: '2026-03-16' },
        })),
      )
      fireEvent.click(screen.getByRole('button', { name: 'Month' }))
      await waitFor(() =>
        expect(listPage).toHaveBeenCalledWith('task', expect.objectContaining({
          lt: { date_start: '2026-09-01' }, gte: { deadline: '2026-03-01' },
        })),
      )
      expect(await screen.findByTestId('gantt-row-1')).toBeInTheDocument()
    })

    it('keeps a tighter search-bar bound on the same columns', async () => {
      const listPage = vi.fn<ListPage>(async () => ({ records: [], total: 0 }))
      serverRender(listPage, { lt: { date_start: '2026-03-10' }, gte: { deadline: '2026-01-01' } })
      await waitFor(() =>
        expect(listPage).toHaveBeenCalledWith('task', expect.objectContaining({
          lt: { date_start: '2026-03-10' }, gte: { deadline: '2026-03-02' },
        })),
      )
    })

    it('pages until a short page, stopping at a cap with a caption past it', async () => {
      const full = (page: number) =>
        Array.from({ length: 200 }, (_, i) => ({ ...alpha, id: `r${page}-${i}` }))
      const listPage = vi.fn<ListPage>(async (_e: string, o?: EntityListOptions) =>
        o?.empty ? { records: [], total: 0 } : { records: full(o?.page ?? 1), total: 50, totalEstimated: true as const },
      )
      serverRender(listPage)
      expect(await screen.findByText(/1000 records shown/)).toBeInTheDocument()
      const rangeCalls = listPage.mock.calls.filter(([, o]) => !o?.empty)
      expect(rangeCalls.map(([, o]) => [o?.page, o?.pageSize])).toEqual([[1, 200], [2, 200], [3, 200], [4, 200], [5, 200], [1001, 1]])
    }, 20_000) // renders 1000 rows: over the 5 s default under full-suite load

    it('exactly the cap of matching records shows no "more records" caption', async () => {
      const listPage = vi.fn<ListPage>(async (_e: string, o?: EntityListOptions) => {
        if (o?.empty || o?.pageSize === 1) return { records: [], total: 1000 }
        return { records: Array.from({ length: 200 }, (_, i) => ({ ...alpha, id: `r${o?.page}-${i}` })), total: 1000 }
      })
      serverRender(listPage)
      await waitFor(() => expect(listPage).toHaveBeenCalledWith('task', expect.objectContaining({ page: 1001, pageSize: 1 })))
      await screen.findAllByTestId(/^gantt-row-r1-/)
      expect(screen.queryByText(/records shown/)).toBeNull()
    }, 20_000) // renders 1000 rows: over the 5 s default under full-suite load

    it('stops paging at the first short page', async () => {
      const listPage = vi.fn<ListPage>(async (_e: string, o?: EntityListOptions) =>
        o?.empty ? { records: [beta], total: 1 } : { records: [alpha], total: 99_999, totalEstimated: true as const },
      )
      serverRender(listPage)
      await screen.findByTestId('gantt-row-1')
      expect(listPage.mock.calls.filter(([, o]) => !o?.empty)).toHaveLength(1)
      expect(screen.queryByText(/records shown/)).toBeNull()
      // Beta came back from both unscheduled queries: listed once.
      expect(screen.getAllByText('Beta')).toHaveLength(1)
    })

    it('surfaces a load error', async () => {
      const listPage = vi.fn<ListPage>(async () => {
        throw new ApiError({ code: 'BAD', message: 'load failed', status: 400 })
      })
      serverRender(listPage)
      expect(await screen.findByText('load failed')).toBeInTheDocument()
    })
  })

  describe('dragging', () => {
    beforeEach(() => sizeTrack())

    it('moving a bar shifts both dates by the same whole-day delta', async () => {
      renderGantt()
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      drag(screen.getByTestId('gantt-bar-1'), 220) // 2.2 days → snaps to 2
      await waitFor(() => expect(update).toHaveBeenCalledWith('1', { date_start: '2026-03-04', deadline: '2026-03-10' }))
      expect(parseFloat(screen.getByTestId('gantt-bar-1').style.left)).toBeCloseTo((2 / 14) * 100, 3)
      expect(pushMock).not.toHaveBeenCalled()
    })

    it('a bar click without movement opens the form, never writes', () => {
      renderGantt()
      drag(screen.getByTestId('gantt-bar-1'), 0)
      expect(update).not.toHaveBeenCalled()
      expect(pushMock).toHaveBeenCalledWith('/app/tasks/1')
    })

    it('the start handle resizes the start only', async () => {
      renderGantt()
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      drag(screen.getByTestId('gantt-handle-start-1'), 200)
      await waitFor(() => expect(update).toHaveBeenCalledWith('1', { date_start: '2026-03-04' }))
    })

    it('the end handle resizes the end only, never before the start', async () => {
      renderGantt()
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      drag(screen.getByTestId('gantt-handle-end-1'), -900)
      await waitFor(() => expect(update).toHaveBeenCalledWith('1', { deadline: '2026-03-02' }))
      expect(update).toHaveBeenCalledTimes(1)
    })

    it('a start dragged past the end is clamped to the end', async () => {
      renderGantt()
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      drag(screen.getByTestId('gantt-handle-start-1'), 5000)
      await waitFor(() => expect(update).toHaveBeenCalledWith('1', { date_start: '2026-03-08' }))
    })

    it('keeps the time of a datetime field, writing an ISO instant back', async () => {
      const dt: ViewDescriptor<Task> = {
        ...descriptor,
        fields: descriptor.fields.map((f) => (f.name === 'date_start' ? { ...f, widget: 'datetime' } : f)),
      }
      const startIso = new Date(2026, 2, 2, 9, 30).toISOString()
      renderGantt([{ ...alpha, date_start: startIso }], dt)
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      drag(screen.getByTestId('gantt-bar-1'), 100)
      await waitFor(() =>
        expect(update).toHaveBeenCalledWith('1', {
          date_start: new Date(2026, 2, 3, 9, 30).toISOString(),
          deadline: '2026-03-09',
        }),
      )
    })

    it('reverts the bar and shows the error when the server refuses', async () => {
      update.mockRejectedValueOnce(new ApiError({ code: 'FORBIDDEN', message: 'nope', status: 403 }))
      renderGantt()
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      drag(screen.getByTestId('gantt-bar-1'), 300)
      expect(await screen.findByText('nope')).toBeInTheDocument()
      expect(screen.getByTestId('gantt-bar-1').style.left).toBe('0%')
    })

    it('a cancelled pointer drops the drag: no write, bar back in place', () => {
      renderGantt()
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      const bar = screen.getByTestId('gantt-bar-1')
      fireEvent.pointerDown(bar, { clientX: 500, pointerId: 1 })
      fireEvent.pointerMove(window, { clientX: 800, pointerId: 1 })
      expect(screen.getByTestId('gantt-bar-1').style.left).not.toBe('0%')
      fireEvent.pointerCancel(window, { pointerId: 1 })
      fireEvent.pointerUp(window, { clientX: 800, pointerId: 1 })
      expect(update).not.toHaveBeenCalled()
      expect(screen.getByTestId('gantt-bar-1').style.left).toBe('0%')
    })

    describe('two datetime fields', () => {
      const dt: ViewDescriptor<Task> = {
        ...descriptor,
        fields: descriptor.fields.map((f) => (f.name === 'name' ? f : { ...f, widget: 'datetime' })),
      }
      const start = new Date(2026, 2, 2, 9, 30).toISOString()
      const end = new Date(2026, 2, 4, 8, 0).toISOString()

      it('an end resized onto the start day never lands before the start instant', async () => {
        renderGantt([{ ...alpha, date_start: start, deadline: end }], dt)
        fireEvent.click(screen.getByRole('button', { name: 'Day' }))
        drag(screen.getByTestId('gantt-handle-end-1'), -200)
        await waitFor(() => expect(update).toHaveBeenCalledWith('1', { deadline: start }))
      })

      it('a start resized onto the end day never lands after the end instant', async () => {
        renderGantt([{ ...alpha, date_start: start, deadline: end }], dt)
        fireEvent.click(screen.getByRole('button', { name: 'Day' }))
        drag(screen.getByTestId('gantt-handle-start-1'), 5000)
        await waitFor(() => expect(update).toHaveBeenCalledWith('1', { date_start: end }))
      })
    })

    it('is read-only without the write permission', () => {
      grant(false)
      renderGantt()
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      expect(screen.queryByTestId('gantt-handle-start-1')).toBeNull()
      expect(screen.queryByTestId('gantt-handle-end-1')).toBeNull()
      drag(screen.getByTestId('gantt-bar-1'), 300)
      expect(update).not.toHaveBeenCalled()
    })
  })

  describe('dragging a bar off the timeline', () => {
    beforeEach(() => sizeTrack())

    it('clears its start, puts it back in Unscheduled, and Undo restores it', async () => {
      renderGantt()
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      const bar = screen.getByTestId('gantt-bar-1')
      fireEvent.pointerDown(bar, { clientX: 500, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(window, { clientX: 1600, clientY: 300, pointerId: 1 })
      fireEvent.pointerUp(window, { clientX: 1600, clientY: 300, pointerId: 1 })
      await waitFor(() => expect(update).toHaveBeenCalledWith('1', { date_start: null }))
      expect(screen.getByTestId('gantt-unscheduled-1')).toBeInTheDocument()
      expect(screen.queryByTestId('gantt-bar-1')).toBeNull()
      expect(useUndoToastStore.getState().pending?.message).toBe('Unscheduled "Alpha"')
      act(() => useUndoToastStore.getState().recover())
      await waitFor(() => expect(update).toHaveBeenLastCalledWith('1', { date_start: alpha.date_start }))
      expect(await screen.findByTestId('gantt-bar-1')).toBeInTheDocument()
    })

    it('an edge handle dragged off the timeline only resizes, never unschedules', async () => {
      renderGantt()
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      fireEvent.pointerDown(screen.getByTestId('gantt-handle-end-1'), { clientX: 500, clientY: 10, pointerId: 1 })
      fireEvent.pointerMove(window, { clientX: 700, clientY: 300, pointerId: 1 })
      fireEvent.pointerUp(window, { clientX: 700, clientY: 300, pointerId: 1 })
      await waitFor(() => expect(update).toHaveBeenCalled())
      expect(update.mock.calls[0][1]).not.toHaveProperty('date_start')
    })
  })

  describe('dragging from Unscheduled', () => {
    beforeEach(() => sizeTrack())

    /** Drops the Unscheduled card of `id` at the pointer position x (Day zoom: 100px per day). */
    function place(id: string, x: number, y = 10) {
      const card = screen.getByTestId(`gantt-unscheduled-${id}`)
      fireEvent.pointerDown(card, { clientX: 1500, clientY: 300, pointerId: 1 })
      fireEvent.pointerMove(window, { clientX: x, clientY: y, pointerId: 1 })
      fireEvent.pointerUp(window, { clientX: x, clientY: y, pointerId: 1 })
    }

    it('dropping on a day sets the start there and keeps an end that is not before it', async () => {
      renderGantt()
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      place('2', 250) // day 2 = 2026-03-04, before Beta's deadline 2026-03-05
      await waitFor(() => expect(update).toHaveBeenCalledWith('2', { date_start: '2026-03-04' }))
      expect(parseFloat(screen.getByTestId('gantt-bar-2').style.left)).toBeCloseTo((2 / 14) * 100, 3)
      expect(pushMock).not.toHaveBeenCalled()
    })

    it('an end before the dropped day becomes a one-day bar', async () => {
      renderGantt()
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      place('2', 550) // day 5 = 2026-03-07, after the deadline
      await waitFor(() => expect(update).toHaveBeenCalledWith('2', { date_start: '2026-03-07', deadline: '2026-03-07' }))
    })

    it('a record with no end gets end = start; a datetime start is written as an ISO instant', async () => {
      const dt: ViewDescriptor<Task> = {
        ...descriptor,
        fields: descriptor.fields.map((f) => (f.name === 'date_start' ? { ...f, widget: 'datetime' } : f)),
      }
      renderGantt([alpha, { id: '4', name: 'Open', date_start: null, deadline: null }], dt)
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      place('4', 150)
      await waitFor(() =>
        expect(update).toHaveBeenCalledWith('4', { date_start: new Date(2026, 2, 3).toISOString(), deadline: '2026-03-03' }),
      )
    })

    it('while dragging, a preview follows the pointer and the target day is highlighted; both go on drop', async () => {
      renderGantt()
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      const card = screen.getByTestId('gantt-unscheduled-2')
      fireEvent.pointerDown(card, { clientX: 1500, clientY: 300, pointerId: 1 })
      fireEvent.pointerMove(window, { clientX: 250, clientY: 10, pointerId: 1 })
      const preview = screen.getByTestId('gantt-drag-preview')
      expect(preview).toHaveTextContent('Beta')
      expect(preview.style.left).toBe('262px')
      const highlight = screen.getByTestId('gantt-drop-day').firstElementChild as HTMLElement
      expect(parseFloat(highlight.style.left)).toBeCloseTo((2 / 14) * 100, 3)
      fireEvent.pointerUp(window, { clientX: 250, clientY: 10, pointerId: 1 })
      expect(screen.queryByTestId('gantt-drag-preview')).toBeNull()
      expect(screen.queryByTestId('gantt-drop-day')).toBeNull()
      await waitFor(() => expect(update).toHaveBeenCalledWith('2', { date_start: '2026-03-04' }))
    })

    it('no highlight while the pointer is off the timeline', () => {
      renderGantt()
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      fireEvent.pointerDown(screen.getByTestId('gantt-unscheduled-2'), { clientX: 1500, clientY: 300, pointerId: 1 })
      fireEvent.pointerMove(window, { clientX: 1600, clientY: 400, pointerId: 1 }) // right of the 1400px track
      expect(screen.getByTestId('gantt-drag-preview')).toBeInTheDocument()
      expect(screen.queryByTestId('gantt-drop-day')).toBeNull()
    })

    it('with nothing scheduled, the empty timeline invites a drop', () => {
      renderGantt([{ id: '4', name: 'Open', date_start: null, deadline: null }])
      expect(screen.getByText('Drag an unscheduled record onto the timeline to plan it.')).toBeInTheDocument()
    })

    it('a drop outside the timeline writes nothing', () => {
      renderGantt()
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      place('2', 1500)
      place('2', 250, 500)
      expect(update).not.toHaveBeenCalled()
    })

    it('a card click without movement opens the form', () => {
      renderGantt()
      const card = screen.getByTestId('gantt-unscheduled-2')
      fireEvent.pointerDown(card, { clientX: 1500, clientY: 300, pointerId: 1 })
      fireEvent.pointerUp(window, { clientX: 1500, clientY: 300, pointerId: 1 })
      expect(update).not.toHaveBeenCalled()
      expect(pushMock).toHaveBeenCalledWith('/app/tasks/2')
    })

    it('a refused drop puts the record back in the panel and shows the error', async () => {
      update.mockRejectedValueOnce(new ApiError({ code: 'FORBIDDEN', message: 'nope', status: 403 }))
      renderGantt()
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      place('2', 250)
      expect(await screen.findByText('nope')).toBeInTheDocument()
      expect(screen.queryByTestId('gantt-bar-2')).toBeNull()
      expect(screen.getByTestId('gantt-unscheduled-2')).toBeInTheDocument()
    })

    it('is read-only without the write permission: a card only opens the form', () => {
      grant(false)
      renderGantt()
      fireEvent.click(screen.getByRole('button', { name: 'Day' }))
      place('2', 250)
      expect(update).not.toHaveBeenCalled()
      fireEvent.click(screen.getByTestId('gantt-unscheduled-2'))
      expect(pushMock).toHaveBeenCalledWith('/app/tasks/2')
    })
  })

  describe('keyboard', () => {
    const fmt = (y: number, m: number, d: number) => new Date(y, m - 1, d).toLocaleDateString()
    const bar = () => screen.getByRole('button', { name: /^Alpha:/ })

    it('each bar is a focusable button labeled with its dates', () => {
      renderGantt()
      expect(bar()).toHaveAttribute('tabindex', '0')
      expect(bar()).toHaveAccessibleName(`Alpha: ${fmt(2026, 3, 2)} – ${fmt(2026, 3, 8)}`)
    })

    it('arrows move the bar, Shift resizes the end, Alt resizes the start', async () => {
      renderGantt()
      fireEvent.keyDown(bar(), { key: 'ArrowRight' })
      await waitFor(() => expect(update).toHaveBeenCalledWith('1', { date_start: '2026-03-03', deadline: '2026-03-09' }))
      expect(bar()).toHaveAccessibleName(`Alpha: ${fmt(2026, 3, 3)} – ${fmt(2026, 3, 9)}`)
      fireEvent.keyDown(bar(), { key: 'ArrowLeft', shiftKey: true })
      await waitFor(() => expect(update).toHaveBeenLastCalledWith('1', { deadline: '2026-03-08' }))
      fireEvent.keyDown(bar(), { key: 'ArrowRight', altKey: true })
      await waitFor(() => expect(update).toHaveBeenLastCalledWith('1', { date_start: '2026-03-04' }))
      fireEvent.keyDown(bar(), { key: 'ArrowLeft' })
      await waitFor(() => expect(update).toHaveBeenLastCalledWith('1', { date_start: '2026-03-03', deadline: '2026-03-07' }))
    })

    it('a resize never puts the end before the start', () => {
      renderGantt([{ id: '1', name: 'Alpha', date_start: '2026-03-03', deadline: '2026-03-03' }])
      fireEvent.keyDown(bar(), { key: 'ArrowLeft', shiftKey: true })
      fireEvent.keyDown(bar(), { key: 'ArrowRight', altKey: true })
      expect(update).not.toHaveBeenCalled()
    })

    it('a refused key move reverts and shows the error', async () => {
      update.mockRejectedValueOnce(new ApiError({ code: 'FORBIDDEN', message: 'nope', status: 403 }))
      renderGantt()
      fireEvent.keyDown(bar(), { key: 'ArrowRight' })
      expect(await screen.findByText('nope')).toBeInTheDocument()
      expect(bar()).toHaveAccessibleName(`Alpha: ${fmt(2026, 3, 2)} – ${fmt(2026, 3, 8)}`)
    })

    it('ignores further moves of a bar while its write is pending; a failure restores the server state', async () => {
      let fail!: (e: unknown) => void
      update.mockImplementationOnce(() => new Promise<Task>((_, reject) => { fail = reject }))
      renderGantt()
      fireEvent.keyDown(bar(), { key: 'ArrowRight' })
      fireEvent.keyDown(bar(), { key: 'ArrowRight' })
      fireEvent.pointerDown(bar(), { clientX: 500, pointerId: 1 })
      fireEvent.pointerMove(window, { clientX: 2000, pointerId: 1 })
      fireEvent.pointerUp(window, { clientX: 2000, pointerId: 1 })
      expect(update).toHaveBeenCalledTimes(1)
      fail(new ApiError({ code: 'FORBIDDEN', message: 'nope', status: 403 }))
      expect(await screen.findByText('nope')).toBeInTheDocument()
      expect(bar()).toHaveAccessibleName(`Alpha: ${fmt(2026, 3, 2)} – ${fmt(2026, 3, 8)}`)
      // Settled: the bar moves again.
      fireEvent.keyDown(bar(), { key: 'ArrowRight' })
      await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    })

    it('leaves Ctrl/Meta + arrows to the browser', () => {
      renderGantt()
      fireEvent.keyDown(bar(), { key: 'ArrowRight', ctrlKey: true })
      fireEvent.keyDown(bar(), { key: 'ArrowLeft', metaKey: true })
      expect(update).not.toHaveBeenCalled()
    })

    it('Enter opens the form; read-only bars ignore arrows', () => {
      grant(false)
      renderGantt()
      fireEvent.keyDown(bar(), { key: 'ArrowRight' })
      fireEvent.keyDown(bar(), { key: 'ArrowLeft', shiftKey: true })
      expect(update).not.toHaveBeenCalled()
      fireEvent.keyDown(bar(), { key: 'Enter' })
      expect(pushMock).toHaveBeenCalledWith('/app/tasks/1')
    })
  })

  describe('dependency arrows', () => {
    const deps = { entity: 'dep', fromField: 'depends_on_id', toField: 'task_id' }
    const gamma: Task = { id: '3', name: 'Gamma', date_start: '2026-03-09', deadline: '2026-03-10' }

    function depRender(data: Task[], listPage: ListPage) {
      const ops = { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn(), listPage }
      return render(
        <RelationOpsProvider ops={ops}>
          <GanttRenderer
            descriptor={descriptor}
            initialData={data}
            actions={actions}
            startField="date_start"
            endField="deadline"
            dependencies={deps}
          />
        </RelationOpsProvider>,
      )
    }

    it('draws an arrow for each link whose two tasks are on the timeline', async () => {
      const listPage = vi.fn<ListPage>(async () => ({
        records: [
          { id: 'd1', depends_on_id: '1', task_id: '3' },
          { id: 'd2', depends_on_id: '99', task_id: '3' },
        ],
        total: 2,
      }))
      depRender([alpha, gamma, beta], listPage)
      expect(await screen.findByTestId('gantt-arrow-d1')).toBeInTheDocument()
      expect(screen.queryByTestId('gantt-arrow-d2')).toBeNull()
      expect(listPage).toHaveBeenCalledWith('dep', expect.objectContaining({ in: { task_id: ['1', '3'] }, page: 1 }))
    })

    it('loads links in chunks of 100 ids, paging each until a short page, never again on a move', async () => {
      const many = Array.from({ length: 150 }, (_, i) => ({ ...alpha, id: `t${i}` }))
      const listPage = vi.fn<ListPage>(async (_e: string, o?: EntityListOptions) =>
        o?.page === 1 && o.in?.task_id.length === 100
          ? { records: Array.from({ length: 200 }, (_, i) => ({ id: `l${i}`, depends_on_id: 'x', task_id: 'y' })), total: 201 }
          : { records: [], total: 0 },
      )
      depRender(many, listPage)
      await waitFor(() => expect(listPage).toHaveBeenCalledTimes(3))
      const calls = listPage.mock.calls.map(([, o]) => [o?.in?.task_id.length, o?.page])
      expect(calls).toEqual(expect.arrayContaining([[100, 1], [100, 2], [50, 1]]))
      // A move reorders the rows but keeps the same id set: no link reload.
      fireEvent.keyDown(screen.getAllByRole('button', { name: /^Alpha:/ })[0], { key: 'ArrowRight' })
      await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
      await new Promise((r) => setTimeout(r, 50))
      expect(listPage).toHaveBeenCalledTimes(3)
    }, 20_000)
  })

  describe('color groups', () => {
    const colorsField = {
      name: 'color_groups',
      label: 'Color groups',
      type: 'relation' as const,
      widget: 'colortags',
      relation: { entity: 'color', kind: 'many2many' as const, via: 'task_color', viaFields: { own: 'task_id', related: 'color_id' }, labelField: 'name' },
    }
    const colored: ViewDescriptor<Task> = { ...descriptor, fields: [...descriptor.fields, colorsField] }
    const gamma: Task = { id: '3', name: 'Gamma', date_start: '2026-03-03', deadline: '2026-03-04' }
    const plain: Task = { id: '4', name: 'Plain', date_start: '2026-03-03', deadline: '2026-03-04' }

    function colorRender() {
      const list = vi.fn(async (entity: string) =>
        entity === 'task_color'
          ? [
              { id: 'j1', task_id: '1', color_id: 'c1' },
              { id: 'j2', task_id: '1', color_id: 'c2' },
              { id: 'j3', task_id: '3', color_id: 'c1' },
            ]
          : [
              { id: 'c1', name: 'Red', color: '#ff0000' },
              { id: 'c2', name: 'Green', color: '#00ff00' },
            ],
      )
      const ops: RelationOps = { list, get: vi.fn(), create: vi.fn(), remove: vi.fn() }
      render(
        <RelationOpsProvider ops={ops}>
          <GanttRenderer
            descriptor={colored}
            initialData={[alpha, gamma, plain]}
            actions={actions}
            startField="date_start"
            endField="deadline"
            colorTagsField="color_groups"
          />
        </RelationOpsProvider>,
      )
      return list
    }

    it('fills a bar with its color, or equal hard stripes for several, and leaves an uncolored bar alone', async () => {
      colorRender()
      await waitFor(() => expect(screen.getByTestId('gantt-bar-3').style.background).toBe('rgb(255, 0, 0)'))
      expect(screen.getByTestId('gantt-bar-1').style.background).toBe(
        // Horizontal bands ('to bottom', the default jsdom drops), one per color, hard edges.
        'linear-gradient(rgb(255, 0, 0) 0%, rgb(255, 0, 0) 50%, rgb(0, 255, 0) 50%, rgb(0, 255, 0) 100%)',
      )
      expect(screen.getByTestId('gantt-bar-4').style.background).toBe('')
    })

    it('the color button opens the color-tags picker for that record', async () => {
      const list = colorRender()
      fireEvent.click(screen.getByRole('button', { name: 'Colors of Alpha' }))
      const picker = await screen.findByRole('dialog', { name: 'Colors of Alpha' })
      expect(await within(picker).findByText('Green')).toBeInTheDocument()
      expect(within(picker).getByRole('combobox')).toBeInTheDocument()
      expect(list).toHaveBeenCalledWith('task_color', expect.objectContaining({ filter: { task_id: '1' } }))
    })

    it('a refused unlink shows its error inside the picker, not in the list behind it', async () => {
      const ops: RelationOps = {
        list: vi.fn(async (entity: string) =>
          entity === 'task_color' ? [{ id: 'j1', task_id: '1', color_id: 'c1' }] : [{ id: 'c1', name: 'Red', color: '#ff0000' }],
        ),
        get: vi.fn(),
        create: vi.fn(),
        remove: vi.fn(async () => Promise.reject(new Error('Refused by Go'))),
      }
      render(
        <BannerScope>
          <div data-testid="outer">
            <BannerSlot />
          </div>
          <RelationOpsProvider ops={ops}>
            <GanttRenderer
              descriptor={colored}
              initialData={[alpha]}
              actions={actions}
              startField="date_start"
              endField="deadline"
              colorTagsField="color_groups"
            />
          </RelationOpsProvider>
        </BannerScope>,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Colors of Alpha' }))
      const picker = await screen.findByRole('dialog', { name: 'Colors of Alpha' })
      const chip = (await within(picker).findByText('Red')).closest('.MuiChip-root')!
      fireEvent.click(chip.querySelector('.MuiChip-deleteIcon')!)
      expect(await within(picker).findByText('Refused by Go')).toBeInTheDocument()
      expect(within(screen.getByTestId('outer')).queryByText('Refused by Go')).toBeNull()
    })

    it('read-only: colors show, no color button', async () => {
      grant(false)
      colorRender()
      await waitFor(() => expect(screen.getByTestId('gantt-bar-3').style.background).toBe('rgb(255, 0, 0)'))
      expect(screen.queryByRole('button', { name: 'Colors of Alpha' })).toBeNull()
    })
  })

  describe('critical path and baselines', () => {
    const scheduleCfg: GanttScheduleConfig = { scopeField: 'project_id', scopeEntity: 'project', path: 'schedule' }
    const baselineCfg: GanttBaselineConfig = {
      entity: 'project_baseline',
      taskEntity: 'project_baseline_task',
      scopeField: 'project_id',
      linkField: 'task_id',
      startField: 'date_start',
      endField: 'deadline',
    }
    const theme = createTheme({ palette: { mode: 'light', error: { main: '#ff0000' }, action: { disabled: '#888888' } } })

    const t1: Task = { id: '1', name: 'Alpha', date_start: '2026-03-02', deadline: '2026-03-08' }
    const t2: Task = { id: '2', name: 'Beta', date_start: '2026-03-03', deadline: '2026-03-06' }

    function opsFor(listPage: ListPage, get: RelationOps['get']) {
      return { list: vi.fn(), get, create: vi.fn(), remove: vi.fn(), listPage }
    }

    /** A pinned list (serverOptions filter[project_id]) with schedule + baseline configs. */
    function pinnedRender(
      listPage: ListPage,
      get: RelationOps['get'],
      d: ViewDescriptor<Task> = descriptor,
      serverOptions: EntityListOptions = { filter: { project_id: 'p1' } },
    ) {
      return render(
        <ThemeProvider theme={theme}>
          <RelationOpsProvider ops={opsFor(listPage, get)}>
            <GanttRenderer
              descriptor={d}
              initialData={[]}
              actions={actions}
              startField="date_start"
              endField="deadline"
              serverOptions={serverOptions}
              schedule={scheduleCfg}
              baseline={baselineCfg}
            />
          </RelationOpsProvider>
        </ThemeProvider>,
      )
    }

    const taskListPage = (records: Task[]) =>
      vi.fn<ListPage>(async (entity: string) => (entity === 'task' ? { records, total: records.length } : { records: [], total: 0 }))

    it('outlines critical bars and shows slack when Critical path is on', async () => {
      const listPage = taskListPage([t1, t2])
      const get = vi.fn(async () => ({
        id: 'p1/schedule',
        start: '2026-03-02',
        finish_days: 6,
        cycle: false,
        tasks: [
          { id: '1', early_start: 0, early_finish: 6, late_start: 0, late_finish: 6, slack: 0, critical: true },
          { id: '2', early_start: 1, early_finish: 4, late_start: 4, late_finish: 7, slack: 3, critical: false },
        ],
      }))
      pinnedRender(listPage, get)
      fireEvent.click(screen.getByRole('button', { name: 'Critical path' }))
      const bar1 = await screen.findByTestId('gantt-bar-1')
      await waitFor(() => expect(bar1.style.outlineWidth).toBe('2px'))
      expect(bar1.style.outlineStyle).toBe('solid')
      expect(bar1.style.outlineColor).toBe('rgb(255, 0, 0)')
      const bar2 = screen.getByTestId('gantt-bar-2')
      await waitFor(() => expect(bar2).toHaveAccessibleName(/, slack 3 d$/))
      expect(get).toHaveBeenCalledWith('project', 'p1/schedule')
    })

    it('hides the critical path toggle when the list is not pinned', () => {
      const listPage = vi.fn<ListPage>(async () => ({ records: [], total: 0 }))
      render(
        <ThemeProvider theme={theme}>
          <RelationOpsProvider ops={opsFor(listPage, vi.fn())}>
            <GanttRenderer
              descriptor={descriptor}
              initialData={[t1]}
              actions={actions}
              startField="date_start"
              endField="deadline"
              schedule={scheduleCfg}
              baseline={baselineCfg}
            />
          </RelationOpsProvider>
        </ThemeProvider>,
      )
      expect(screen.queryByRole('button', { name: 'Critical path' })).toBeNull()
      expect(screen.queryByRole('combobox', { name: 'Baseline' })).toBeNull()
    })

    it('says so when the schedule has a cycle', async () => {
      const listPage = taskListPage([t1, t2])
      const get = vi.fn(async () => ({ id: 'p1/schedule', start: '2026-03-02', cycle: true, tasks: [] }))
      pinnedRender(listPage, get)
      fireEvent.click(screen.getByRole('button', { name: 'Critical path' }))
      expect(await screen.findByText('Dependency cycle: no critical path')).toBeInTheDocument()
    })

    it('draws ghost bars from the picked baseline', async () => {
      const listPage = vi.fn<ListPage>(async (entity: string, o?: EntityListOptions) => {
        if (entity === 'task') return { records: [t1, t2], total: 2 }
        if (entity === 'project_baseline') return { records: [{ id: 'b2', name: 'New' }, { id: 'b1', name: 'Old' }], total: 2 }
        if (entity === 'project_baseline_task') {
          if (o?.filter?.baseline_id === 'b1') return { records: [{ id: 'bt1', task_id: '1', date_start: '2026-03-01', deadline: '2026-03-09' }], total: 1 }
          return { records: [], total: 0 }
        }
        return { records: [], total: 0 }
      })
      pinnedRender(listPage, vi.fn(async () => ({ id: 'p1/schedule', cycle: false, tasks: [] })))
      // Newest first: the read asks for created_at descending.
      await waitFor(() => expect(listPage).toHaveBeenCalledWith('project_baseline', expect.objectContaining({ order: '-created_at' })))
      fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Baseline' }))
      const options = await screen.findAllByRole('option')
      expect(options.map((o) => o.textContent)).toEqual(['No baseline', 'New', 'Old'])
      fireEvent.click(screen.getByRole('option', { name: 'Old' }))
      // t1 is in the picked baseline (a ghost bar); t2 is not (no ghost bar).
      const ghost = await screen.findByTestId('gantt-baseline-1')
      expect(ghost).toHaveStyle({ height: '6px' })
      expect(screen.queryByTestId('gantt-baseline-2')).toBeNull()
    })

    it('keeps the toggle state per entity for the tab session', async () => {
      const listPage = vi.fn<ListPage>(async () => ({ records: [], total: 0 }))
      const get = vi.fn(async () => ({ id: 'p1/schedule', cycle: false, tasks: [] }))
      pinnedRender(listPage, get)
      fireEvent.click(screen.getByRole('button', { name: 'Critical path' }))
      expect(screen.getByRole('button', { name: 'Critical path' })).toHaveAttribute('aria-pressed', 'true')
      cleanup()
      pinnedRender(listPage, get)
      expect(screen.getByRole('button', { name: 'Critical path' })).toHaveAttribute('aria-pressed', 'true')
      cleanup()
      pinnedRender(listPage, get, { ...descriptor, entity: 'other' })
      expect(screen.getByRole('button', { name: 'Critical path' })).toHaveAttribute('aria-pressed', 'false')
      // The pending reads (server load, schedule) settle after the sync body: flush inside act.
      await act(async () => {})
    })

    it('works on phone', async () => {
      setViewportWidth(390)
      const listPage = vi.fn<ListPage>(async (entity: string, o?: EntityListOptions) => {
        if (entity === 'task') return { records: [t1, t2], total: 2 }
        if (entity === 'project_baseline') return { records: [{ id: 'b1', name: 'Old' }], total: 1 }
        if (entity === 'project_baseline_task') {
          if (o?.filter?.baseline_id === 'b1') return { records: [{ id: 'bt1', task_id: '1', date_start: '2026-03-01', deadline: '2026-03-09' }], total: 1 }
          return { records: [], total: 0 }
        }
        return { records: [], total: 0 }
      })
      const get = vi.fn(async () => ({
        id: 'p1/schedule',
        cycle: false,
        tasks: [{ id: '1', early_start: 0, early_finish: 6, late_start: 0, late_finish: 6, slack: 0, critical: true }],
      }))
      pinnedRender(listPage, get)
      // Both controls sit in the phone toolbar's More menu, not inline.
      expect(screen.queryByRole('button', { name: 'Critical path' })).toBeNull()
      expect(screen.queryByRole('combobox', { name: 'Baseline' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'More' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Critical path' }))
      const bar1 = await screen.findByTestId('gantt-bar-1')
      await waitFor(() => expect(bar1.style.outlineWidth).toBe('2px'))
      // Ghost bars still draw: pick the baseline from the same menu.
      fireEvent.click(screen.getByRole('button', { name: 'More' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Old' }))
      expect(await screen.findByTestId('gantt-baseline-1')).toBeInTheDocument()
    })

    it('draws the pinned project milestones as diamonds, colored by state, opening their form', async () => {
      const cfg: GanttMilestonesConfig = { entity: 'project_milestone', scopeField: 'project_id', dateField: 'deadline', labelField: 'name', reachedField: 'reached', formPath: '/project/milestones/:id' }
      const listPage = vi.fn<ListPage>(async (entity: string) => {
        if (entity === 'task') return { records: [t1], total: 1 }
        if (entity === 'project_milestone')
          return {
            records: [
              { id: 'late', name: 'Late', deadline: '2026-03-03T00:00:00Z', reached: false },
              { id: 'next', name: 'Next', deadline: '2026-03-10T00:00:00Z', reached: false },
              { id: 'done', name: 'Done', deadline: '2026-03-02T00:00:00Z', reached: true },
              { id: 'far', name: 'Far', deadline: '2027-06-01T00:00:00Z', reached: false },
              { id: 'none', name: 'No date', deadline: null, reached: false },
            ],
            total: 5,
          }
        return { records: [], total: 0 }
      })
      render(
        <ThemeProvider theme={theme}>
          <RelationOpsProvider ops={opsFor(listPage, vi.fn())}>
            <GanttRenderer descriptor={descriptor} initialData={[]} actions={actions} startField="date_start" endField="deadline" serverOptions={{ filter: { project_id: 'p1' } }} milestones={cfg} />
          </RelationOpsProvider>
        </ThemeProvider>,
      )
      const next = await screen.findByTestId('gantt-milestone-next')
      expect(listPage).toHaveBeenCalledWith('project_milestone', expect.objectContaining({ filter: { project_id: 'p1' }, order: 'deadline' }))
      expect(next).toHaveAccessibleName(`Milestone Next: ${new Date(2026, 2, 10).toLocaleDateString()}`)
      expect(getComputedStyle(screen.getByTestId('gantt-milestone-late')).backgroundColor).toBe('rgb(255, 0, 0)')
      expect(screen.getByTestId('gantt-milestone-done')).toBeInTheDocument()
      // Outside the range, or with no date: no diamond.
      expect(screen.queryByTestId('gantt-milestone-far')).toBeNull()
      expect(screen.queryByTestId('gantt-milestone-none')).toBeNull()
      fireEvent.click(next)
      expect(pushMock).toHaveBeenCalledWith('/app/project/milestones/next')
    })

    it('switches to the Roadmap: every milestone on one line and in a table, exported as PNG or PDF', async () => {
      const cfg: GanttMilestonesConfig = { entity: 'project_milestone', scopeField: 'project_id', dateField: 'deadline', labelField: 'name', reachedField: 'reached', formPath: '/project/milestones/:id' }
      const listPage = vi.fn<ListPage>(async (entity: string) => {
        if (entity === 'project_milestone')
          return {
            records: [
              { id: 'done', name: 'Done', deadline: '2026-03-02T00:00:00Z', reached: true },
              { id: 'far', name: 'Far', deadline: '2027-06-01T00:00:00Z', reached: false },
            ],
            total: 2,
          }
        return { records: [t1], total: 1 }
      })
      const view = () =>
        render(
          <RelationOpsProvider ops={opsFor(listPage, vi.fn())}>
            <GanttRenderer descriptor={descriptor} initialData={[]} actions={actions} startField="date_start" endField="deadline" serverOptions={{ filter: { project_id: 'p1' } }} milestones={cfg} />
          </RelationOpsProvider>,
        )
      view()
      await screen.findByTestId('gantt-milestone-done')
      fireEvent.click(screen.getByRole('button', { name: 'Roadmap' }))
      const roadmap = screen.getByTestId('gantt-roadmap')
      // Out of the timeline's range, still on the roadmap.
      expect(within(roadmap).getByTestId('gantt-roadmap-milestone-far')).toBeInTheDocument()
      expect(within(roadmap).getAllByRole('row')).toHaveLength(3)
      expect(within(roadmap).getByText('Reached')).toBeInTheDocument()
      expect(within(roadmap).getByText('Upcoming')).toBeInTheDocument()
      expect(screen.queryByTestId('gantt-track')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Export PNG' }))
      await waitFor(() => expect(exportElementPng).toHaveBeenCalledWith(roadmap, expect.stringMatching(/^Roadmap /), expect.anything()))
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Export PDF' }))
      await waitFor(() => expect(exportElementPdf).toHaveBeenCalledWith(roadmap, expect.objectContaining({ title: expect.stringMatching(/^Roadmap /) }), expect.anything()))
      fireEvent.click(within(roadmap).getByRole('button', { name: 'Far' }))
      expect(pushMock).toHaveBeenCalledWith('/app/project/milestones/far')
      // Kept for the session, like the zoom.
      cleanup()
      view()
      expect(await screen.findByTestId('gantt-roadmap')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Timeline' }))
      expect(await screen.findByTestId('gantt-track')).toBeInTheDocument()
    })

    it('draws no milestone row when the list is not pinned', async () => {
      const listPage = taskListPage([t1])
      const cfg: GanttMilestonesConfig = { entity: 'project_milestone', scopeField: 'project_id', dateField: 'deadline', labelField: 'name' }
      render(
        <RelationOpsProvider ops={opsFor(listPage, vi.fn())}>
          <GanttRenderer descriptor={descriptor} initialData={[]} actions={actions} startField="date_start" endField="deadline" serverOptions={{}} milestones={cfg} />
        </RelationOpsProvider>,
      )
      await screen.findByTestId('gantt-bar-1')
      expect(screen.queryByTestId('gantt-milestones')).toBeNull()
      expect(listPage).not.toHaveBeenCalledWith('project_milestone', expect.anything())
    })
  })

  describe('plan exchange toolbar', () => {
    const exchangeCfg: GanttExchangeConfig = {
      scopeField: 'project_id',
      scopeEntity: 'project',
      formats: [
        { key: 'gan', label: 'GanttProject (.gan)', accept: '.gan' },
        { key: 'mppdi', label: 'MS Project (MSPDI)', accept: '.xml' },
      ],
      canImport: 'test.exchange',
    }
    const emptyList = vi.fn<ListPage>(async () => ({ records: [], total: 0 }))

    function renderExchange(serverOptions: EntityListOptions | undefined, cfg: GanttExchangeConfig) {
      render(
        <RelationOpsProvider
          ops={{ list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn(), listPage: emptyList }}
        >
          <GanttRenderer
            descriptor={descriptor}
            initialData={[]}
            actions={actions}
            startField="date_start"
            endField="deadline"
            serverOptions={serverOptions}
            exchange={cfg}
          />
        </RelationOpsProvider>,
      )
    }

    const PINNED: EntityListOptions = { filter: { project_id: 'p1' } }

    it('offers no plan file nor Import while the list is not pinned', async () => {
      // The guard passes: the only thing that can keep the Import control hidden here is the missing pin.
      registerKanbanColumnsGuard('test.exchange', async () => true)
      renderExchange(undefined, exchangeCfg)
      // The pending reads (server load, the import guard) settle after the sync body: flush inside act.
      await act(async () => {})
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
      expect(screen.queryByRole('menuitem', { name: 'GanttProject (.gan)' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Import' })).toBeNull()
      cleanup()
      renderExchange({}, exchangeCfg)
      await act(async () => {})
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
      expect(screen.queryByRole('menuitem', { name: 'GanttProject (.gan)' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Import' })).toBeNull()
    })

    it('shows nothing at all without the descriptor config', async () => {
      render(
        <RelationOpsProvider ops={{ list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn(), listPage: emptyList }}>
          <GanttRenderer
            descriptor={descriptor}
            initialData={[]}
            actions={actions}
            startField="date_start"
            endField="deadline"
            serverOptions={PINNED}
          />
        </RelationOpsProvider>,
      )
      await act(async () => {})
      // The image exports stay; no plan file is offered.
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
      expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Export PNG', 'Export PDF'])
    })

    it('Export lists every format as a download of the pinned project', async () => {
      registerKanbanColumnsGuard('test.exchange', async () => false)
      renderExchange(PINNED, exchangeCfg)
      fireEvent.click(await screen.findByRole('button', { name: 'Export' }))
      const gan = await screen.findByRole('menuitem', { name: 'GanttProject (.gan)' })
      expect(gan).toHaveAttribute('href', '/api/exchange/project/p1/gan/export')
      expect(gan).toHaveAttribute('download')
      expect(screen.getByRole('menuitem', { name: 'MS Project (MSPDI)' })).toHaveAttribute(
        'href',
        '/api/exchange/project/p1/mppdi/export',
      )
    })

    it('Export folds in the file the rows folded on screen', async () => {
      sessionStorage.setItem('eerp.gantt.collapsed.task', JSON.stringify(['t1', 't2']))
      registerKanbanColumnsGuard('test.exchange', async () => false)
      renderExchange(PINNED, exchangeCfg)
      fireEvent.click(await screen.findByRole('button', { name: 'Export' }))
      expect(await screen.findByRole('menuitem', { name: 'GanttProject (.gan)' })).toHaveAttribute(
        'href',
        '/api/exchange/project/p1/gan/export?collapsed=t1%2Ct2',
      )
    })

    it('Import appears only when the canImport guard passes, and opens the wizard for that format', async () => {
      registerKanbanColumnsGuard('test.exchange', async () => false)
      renderExchange(PINNED, exchangeCfg)
      await screen.findByRole('button', { name: 'Export' })
      expect(screen.queryByRole('button', { name: 'Import' })).toBeNull()
      cleanup()
      let seen: unknown
      registerKanbanColumnsGuard('test.exchange', async (scopeId, ops) => {
        seen = { scopeId, hasOps: !!ops }
        return true
      })
      renderExchange(PINNED, exchangeCfg)
      fireEvent.click(await screen.findByRole('button', { name: 'Import' }))
      expect(seen).toEqual({ scopeId: 'p1', hasOps: true })
      fireEvent.click(await screen.findByRole('menuitem', { name: 'GanttProject (.gan)' }))
      expect(await screen.findByText('Import GanttProject (.gan)')).toBeInTheDocument()
    })

    it('on phone Export is an icon button and Import sits in the More menu', async () => {
      setViewportWidth(390)
      registerKanbanColumnsGuard('test.exchange', async () => true)
      renderExchange(PINNED, exchangeCfg)
      expect(screen.getByRole('button', { name: 'Export' })).not.toHaveTextContent('Export')
      expect(screen.queryByRole('button', { name: 'Import' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
      expect(await screen.findByRole('menuitem', { name: 'GanttProject (.gan)' })).toHaveAttribute(
        'href',
        '/api/exchange/project/p1/gan/export',
      )
      cleanup()
      setViewportWidth(390)
      renderExchange(PINNED, exchangeCfg)
      fireEvent.click(await screen.findByRole('button', { name: 'More' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Import' }))
      expect(await screen.findByRole('menuitem', { name: 'MS Project (MSPDI)' })).toBeInTheDocument()
    })
  })
})
