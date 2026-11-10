import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

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
})
