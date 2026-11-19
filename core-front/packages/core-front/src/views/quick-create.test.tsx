import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

import { CalendarRenderer } from './calendar-renderer'
import { GanttRenderer } from './gantt-renderer'
import { KanbanRenderer } from './kanban-renderer'
import type { ViewDescriptor } from './descriptor'
import type { EntityActions } from './stores'
import { RelationOpsProvider, type RelationOps } from './relation-ops'
import { useSessionStore } from './session-store'

// A click on an empty spot of a Gantt row, a Calendar day or a Kanban column
// opens the create dialog pre-filled from that spot; the created record shows in place.

type Task = { id: string; name: string; status?: string | null; date_start?: string | null; deadline?: string | null }

const descriptor: ViewDescriptor<Task> = {
  entity: 'task',
  viewType: 'tree',
  formPath: '/tasks/:id',
  fields: [
    { name: 'name', label: 'Name', type: 'text' },
    { name: 'status', label: 'Status', type: 'selection', selection: { options: ['open', 'done'] } },
    { name: 'date_start', label: 'Start', type: 'date' },
    { name: 'deadline', label: 'Deadline', type: 'date' },
  ],
}

const actions: EntityActions<Task> = { create: vi.fn(), update: vi.fn(async (id, b) => ({ id, ...b }) as Task) }

function grant(write: boolean) {
  useSessionStore.setState({
    identity: { userId: 'u1', tenantId: 't1', roles: [], permissions: write ? ['task:task:read', 'task:task:write'] : ['task:task:read'] },
  })
}

function opsCreating(): RelationOps {
  return {
    list: vi.fn(async () => []),
    get: vi.fn(),
    create: vi.fn(async (_e: string, body: Record<string, unknown>) => ({ id: 'new-1', ...body })),
    remove: vi.fn(),
  }
}

async function fillAndCreate(ops: RelationOps) {
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Fresh' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  await waitFor(() => expect(ops.create).toHaveBeenCalled())
  return (ops.create as ReturnType<typeof vi.fn>).mock.calls[0]
}

beforeEach(() => grant(true))

describe('quick create', () => {
  it('Kanban: a click on a column creates a card with that status', async () => {
    const ops = opsCreating()
    render(
      <RelationOpsProvider ops={ops}>
        <KanbanRenderer descriptor={descriptor} initialData={[]} actions={actions} statusField="status" />
      </RelationOpsProvider>,
    )
    fireEvent.click(screen.getByRole('group', { name: 'done' }))
    const [entity, body] = await fillAndCreate(ops)
    expect(entity).toBe('task')
    expect(body).toMatchObject({ name: 'Fresh', status: 'done' })
    expect(await screen.findByText('Fresh')).toBeInTheDocument()
  })

  it('Calendar: a click on a day creates a record on that day', async () => {
    const ops = opsCreating()
    render(
      <RelationOpsProvider ops={ops}>
        <CalendarRenderer descriptor={descriptor} initialData={[]} actions={actions} dateField="deadline" />
      </RelationOpsProvider>,
    )
    const now = new Date()
    const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-10`
    fireEvent.click(screen.getByRole('group', { name: iso }))
    const [, body] = await fillAndCreate(ops)
    expect(body).toMatchObject({ name: 'Fresh', deadline: iso })
    expect(await screen.findByText('Fresh')).toBeInTheDocument()
  })

  it('Gantt: a click on a row\'s empty track creates a record on that day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 2, 4, 12))
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 1400, height: 20, top: 0, left: 0, right: 1400, bottom: 20, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    const ops = opsCreating()
    const alpha: Task = { id: '1', name: 'Alpha', date_start: '2026-03-02', deadline: '2026-03-03' }
    render(
      <RelationOpsProvider ops={ops}>
        <GanttRenderer descriptor={descriptor} initialData={[alpha]} actions={actions} startField="date_start" endField="deadline" />
      </RelationOpsProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Day' }))
    // Day zoom: 14 days from Monday 2026-03-02, 100px each → x=550 is day 5 (Saturday 7th).
    fireEvent.click(screen.getByTestId('gantt-row-track-1'), { clientX: 550 })
    const [, body] = await fillAndCreate(ops)
    expect(body).toMatchObject({ name: 'Fresh', date_start: '2026-03-07', deadline: '2026-03-07' })
    expect(await screen.findByText('Fresh')).toBeInTheDocument()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('a click on a card opens no create dialog', () => {
    render(
      <RelationOpsProvider ops={opsCreating()}>
        <KanbanRenderer descriptor={descriptor} initialData={[{ id: '1', name: 'Acme', status: 'done' }]} actions={actions} statusField="status" />
      </RelationOpsProvider>,
    )
    fireEvent.click(screen.getByText('Acme'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens nothing without the write right', () => {
    grant(false)
    render(
      <RelationOpsProvider ops={opsCreating()}>
        <KanbanRenderer descriptor={descriptor} initialData={[]} actions={actions} statusField="status" />
      </RelationOpsProvider>,
    )
    fireEvent.click(screen.getByRole('group', { name: 'done' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
