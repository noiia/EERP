import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CalendarRenderer } from './calendar-renderer'
import type { ViewDescriptor } from './descriptor'
import type { EntityActions } from './stores'
import { ApiError } from '../api/errors'

interface Task {
  id: string
  name: string
  due_date?: string | null
}

const descriptor: ViewDescriptor<Task> = {
  entity: 'tasks',
  viewType: 'tree',
  fields: [
    { name: 'name', label: 'Name', type: 'text' },
    { name: 'due_date', label: 'Due date', type: 'date' },
  ],
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const now = new Date()
const thisYear = now.getFullYear()
const thisMonth = now.getMonth()
const day15 = iso(thisYear, thisMonth, 15)
const day20 = iso(thisYear, thisMonth, 20)

const records: Task[] = [
  { id: '1', name: 'Alpha', due_date: day15 },
  { id: '2', name: 'Beta', due_date: null },
]

function drag(fromId: string, toLabel: string) {
  fireEvent.dragStart(screen.getByTestId(`calendar-card-${fromId}`))
  const target = screen.getByRole('group', { name: toLabel })
  fireEvent.dragOver(target)
  fireEvent.drop(target)
}

describe('CalendarRenderer', () => {
  let update: ReturnType<typeof vi.fn<(id: string, body: Partial<Task>) => Promise<Task>>>
  let actions: EntityActions<Task>

  beforeEach(() => {
    update = vi.fn(async (id: string, body: Partial<Task>) => ({ id, ...body }) as Task)
    actions = { create: vi.fn(async (b) => b as Task), update }
  })

  it('positions a scheduled record on its day and lists a dateless one as Unscheduled', () => {
    render(
      <CalendarRenderer descriptor={descriptor} initialData={records} actions={actions} dateField="due_date" />,
    )
    expect(screen.getByRole('group', { name: day15 })).toHaveTextContent('Alpha')
    expect(screen.getByRole('group', { name: 'Unscheduled' })).toHaveTextContent('Beta')
  })

  it('positions a record whose date field is a full RFC3339 timestamp (a real Go time.Time column), not just a bare date string', () => {
    // A `time.Time` column round-trips as "2026-07-10T00:00:00Z", never a bare
    // 'YYYY-MM-DD' — bucketing by the raw value would never match an
    // isoDate() day key, silently dropping the record from BOTH the grid and
    // Unscheduled (the exact bug this guards against).
    const timestampRecords: Task[] = [{ id: '3', name: 'Gamma', due_date: `${day15}T00:00:00Z` }]
    render(
      <CalendarRenderer
        descriptor={descriptor}
        initialData={timestampRecords}
        actions={actions}
        dateField="due_date"
      />,
    )
    expect(screen.getByRole('group', { name: day15 })).toHaveTextContent('Gamma')
    expect(screen.queryByRole('group', { name: 'Unscheduled' })).not.toHaveTextContent('Gamma')
  })

  it('dragging a scheduled record to another day PATCHes the date field', async () => {
    render(
      <CalendarRenderer descriptor={descriptor} initialData={records} actions={actions} dateField="due_date" />,
    )
    drag('1', day20)
    // Optimistic: moves before the Server Action resolves.
    expect(screen.getByRole('group', { name: day20 })).toHaveTextContent('Alpha')
    await waitFor(() => expect(update).toHaveBeenCalledWith('1', { due_date: day20 }))
  })

  it('dragging an unscheduled record onto a day schedules it', async () => {
    render(
      <CalendarRenderer descriptor={descriptor} initialData={records} actions={actions} dateField="due_date" />,
    )
    drag('2', day20)
    await waitFor(() => expect(update).toHaveBeenCalledWith('2', { due_date: day20 }))
    expect(screen.getByRole('group', { name: day20 })).toHaveTextContent('Beta')
  })

  it('dragging a scheduled record into Unscheduled clears its date', async () => {
    render(
      <CalendarRenderer descriptor={descriptor} initialData={records} actions={actions} dateField="due_date" />,
    )
    drag('1', 'Unscheduled')
    await waitFor(() => expect(update).toHaveBeenCalledWith('1', { due_date: null }))
    expect(screen.getByRole('group', { name: 'Unscheduled' })).toHaveTextContent('Alpha')
  })

  it('dropping on the same day is a no-op', () => {
    render(
      <CalendarRenderer descriptor={descriptor} initialData={records} actions={actions} dateField="due_date" />,
    )
    drag('1', day15)
    expect(update).not.toHaveBeenCalled()
  })

  it('navigating months re-filters the SAME records instead of refetching', () => {
    render(
      <CalendarRenderer descriptor={descriptor} initialData={records} actions={actions} dateField="due_date" />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    // Unaffected by month navigation — it isn't month-scoped.
    expect(screen.getByRole('group', { name: 'Unscheduled' })).toHaveTextContent('Beta')

    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(screen.getByRole('group', { name: day15 })).toHaveTextContent('Alpha')
  })

  it('reverts the move and surfaces the error on a rejected write', async () => {
    update.mockRejectedValue(new ApiError({ code: 'FORBIDDEN', message: 'no', status: 403 }))
    render(
      <CalendarRenderer descriptor={descriptor} initialData={records} actions={actions} dateField="due_date" />,
    )
    drag('1', day20)

    await screen.findByText('FORBIDDEN')
    expect(screen.getByRole('group', { name: day15 })).toHaveTextContent('Alpha')
    expect(screen.getByRole('group', { name: day20 })).not.toHaveTextContent('Alpha')
  })
})
