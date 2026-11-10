import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

import { GanttRenderer } from './gantt-renderer'
import type { ViewDescriptor } from './descriptor'
import type { EntityActions } from './stores'
import { RelationOpsProvider, type RelationOps } from './relation-ops'
import { useSessionStore } from './session-store'
import { ApiError } from '../api/errors'
import type { EntityListOptions } from '../api/list-options'

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

  it('marks today on the timeline only while today is in the visible range', () => {
    renderGantt()
    expect(screen.getByRole('img', { name: 'Today' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Day' }))
    // Day zoom: 14 days from Monday 2026-03-02, today (index 2) at the middle of its column.
    expect(screen.getByRole('img', { name: 'Today' }).style.left).toBe(`${(2.5 / 14) * 100}%`)
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
      expect(screen.getByTestId('gantt-bar-1').style.left).toBe(`${(2 / 14) * 100}%`)
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
      expect(screen.getByTestId('gantt-bar-2').style.left).toBe(`${(2 / 14) * 100}%`)
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
        'linear-gradient(rgb(255, 0, 0) 0% 50%, rgb(0, 255, 0) 50% 100%)',
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

    it('read-only: colors show, no color button', async () => {
      grant(false)
      colorRender()
      await waitFor(() => expect(screen.getByTestId('gantt-bar-3').style.background).toBe('rgb(255, 0, 0)'))
      expect(screen.queryByRole('button', { name: 'Colors of Alpha' })).toBeNull()
    })
  })
})
