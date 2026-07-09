import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { KanbanRenderer } from './kanban-renderer'
import type { ViewDescriptor } from './descriptor'
import type { EntityActions } from './stores'
import { ApiError } from '../api/errors'

interface Deal {
  id: string
  name: string
  status?: string | null
}

const descriptor: ViewDescriptor<Deal> = {
  entity: 'deals',
  viewType: 'tree',
  fields: [
    { name: 'name', label: 'Name', type: 'text' },
    {
      name: 'status',
      label: 'Status',
      type: 'selection',
      selection: { options: ['open', 'won', 'lost'] },
    },
  ],
}

const records: Deal[] = [
  { id: '1', name: 'Acme', status: 'open' },
  { id: '2', name: 'Globex', status: 'won' },
  { id: '3', name: 'Initech' },
]

function drag(fromId: string, toColumn: string) {
  fireEvent.dragStart(screen.getByTestId(`kanban-card-${fromId}`))
  const column = screen.getByRole('group', { name: toColumn })
  fireEvent.dragOver(column)
  fireEvent.drop(column)
}

describe('KanbanRenderer', () => {
  let update: ReturnType<typeof vi.fn<(id: string, body: Partial<Deal>) => Promise<Deal>>>
  let actions: EntityActions<Deal>

  beforeEach(() => {
    update = vi.fn(async (id: string, body: Partial<Deal>) => ({ id, ...body }) as Deal)
    actions = { create: vi.fn(async (body: Partial<Deal>) => body as Deal), update }
  })

  it('renders one column per declared selection option, in order, plus a trailing No status column', () => {
    render(
      <KanbanRenderer
        descriptor={descriptor}
        initialData={records}
        actions={actions}
        statusField="status"
      />,
    )
    const groups = screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))
    expect(groups).toEqual(['open', 'won', 'lost', 'No status'])
  })

  it('sorts records into their column, including the unset ones into No status', () => {
    render(
      <KanbanRenderer
        descriptor={descriptor}
        initialData={records}
        actions={actions}
        statusField="status"
      />,
    )
    expect(screen.getByRole('group', { name: 'open' })).toHaveTextContent('Acme')
    expect(screen.getByRole('group', { name: 'won' })).toHaveTextContent('Globex')
    expect(screen.getByRole('group', { name: 'No status' })).toHaveTextContent('Initech')
  })

  it('dragging a card to another column optimistically moves it and PATCHes the status field', async () => {
    render(
      <KanbanRenderer
        descriptor={descriptor}
        initialData={records}
        actions={actions}
        statusField="status"
      />,
    )
    drag('1', 'won')

    // Optimistic: moves before the Server Action resolves.
    expect(screen.getByRole('group', { name: 'won' })).toHaveTextContent('Acme')
    expect(screen.getByRole('group', { name: 'open' })).not.toHaveTextContent('Acme')
    await waitFor(() => expect(update).toHaveBeenCalledWith('1', { status: 'won' }))
  })

  it('dragging into No status PATCHes the field to null', async () => {
    render(
      <KanbanRenderer
        descriptor={descriptor}
        initialData={records}
        actions={actions}
        statusField="status"
      />,
    )
    drag('2', 'No status')
    await waitFor(() => expect(update).toHaveBeenCalledWith('2', { status: null }))
  })

  it('dropping on the same column is a no-op', () => {
    render(
      <KanbanRenderer
        descriptor={descriptor}
        initialData={records}
        actions={actions}
        statusField="status"
      />,
    )
    drag('1', 'open')
    expect(update).not.toHaveBeenCalled()
  })

  it('reverts the card and surfaces the error when the write is rejected', async () => {
    update.mockRejectedValue(new ApiError({ code: 'FORBIDDEN', message: 'no', status: 403 }))
    render(
      <KanbanRenderer
        descriptor={descriptor}
        initialData={records}
        actions={actions}
        statusField="status"
      />,
    )
    drag('1', 'won')

    await screen.findByText('FORBIDDEN')
    expect(screen.getByRole('group', { name: 'open' })).toHaveTextContent('Acme')
    expect(screen.getByRole('group', { name: 'won' })).not.toHaveTextContent('Acme')
  })
})
