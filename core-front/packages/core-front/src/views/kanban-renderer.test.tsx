import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

// A card click (no drag) navigates to the record's form via the App Router.
const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

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
    pushMock.mockReset()
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

  it('never prints a geo or distance field on a card', () => {
    const geoDescriptor: ViewDescriptor<Deal> = {
      ...descriptor,
      fields: [
        { name: 'geo_location', label: 'Map position', type: 'geo' },
        ...descriptor.fields,
        { name: 'distance', label: 'Distance', type: 'distance' },
      ],
    }
    const located = records.map((r) => ({ ...r, geo_location: { type: 'Point', coordinates: [2.35, 48.85] } }))
    render(<KanbanRenderer descriptor={geoDescriptor} initialData={located} actions={actions} statusField="status" />)
    expect(screen.getByTestId('kanban-card-1')).toHaveTextContent('Acme')
    expect(screen.queryByText('[object Object]')).toBeNull()
  })

  it('centers the column board when it is narrower than the screen, safely (never past an overflow)', () => {
    render(
      <KanbanRenderer
        descriptor={descriptor}
        initialData={records}
        actions={actions}
        statusField="status"
      />,
    )
    // The board is the flex row that's the common ancestor of every column group.
    const board = screen.getAllByRole('group')[0]!.parentElement!
    expect(board).toHaveStyle({ display: 'flex', justifyContent: 'safe center' })
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

  it('reports its working record set to onRecordsChange, including after an optimistic move', async () => {
    const onRecordsChange = vi.fn()
    render(
      <KanbanRenderer
        descriptor={descriptor}
        initialData={records}
        actions={actions}
        statusField="status"
        onRecordsChange={onRecordsChange}
      />,
    )
    expect(onRecordsChange).toHaveBeenCalledWith(records)

    drag('1', 'won')
    await waitFor(() =>
      expect(onRecordsChange).toHaveBeenLastCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: '1', status: 'won' })]),
      ),
    )
  })

  it('clicking a card (no drag) navigates to its form when the descriptor has one', () => {
    render(
      <KanbanRenderer
        descriptor={{ ...descriptor, formPath: '/deals/:id' }}
        initialData={records}
        actions={actions}
        statusField="status"
      />,
    )
    fireEvent.click(screen.getByTestId('kanban-card-1'))
    expect(pushMock).toHaveBeenCalledWith('/app/deals/1')
  })

  it('does nothing on click when the descriptor has no formPath', () => {
    render(
      <KanbanRenderer
        descriptor={descriptor}
        initialData={records}
        actions={actions}
        statusField="status"
      />,
    )
    fireEvent.click(screen.getByTestId('kanban-card-1'))
    expect(pushMock).not.toHaveBeenCalled()
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

describe('KanbanRenderer with serverOptions', () => {
  it('loads each column from the server and shows its full count, not the cards shown', async () => {
    const { RelationOpsProvider } = await import('./relation-ops')
    const listPage = vi.fn(async (_entity: string, options?: import('../api/list-options').EntityListOptions) => {
      const status = options?.filter?.status
      if (status === 'open') return { records: [{ id: '1', name: 'Acme', status: 'open' }], total: 40_000 }
      if (options?.empty?.includes('status')) return { records: [], total: 7 }
      return { records: [], total: 0 }
    })
    const ops = { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn(), listPage }
    render(
      <RelationOpsProvider ops={ops}>
        <KanbanRenderer
          descriptor={descriptor}
          initialData={[]}
          actions={{ create: vi.fn(), update: vi.fn() }}
          statusField="status"
          serverOptions={{ search: { name: 'ac' } }}
        />
      </RelationOpsProvider>,
    )
    await waitFor(() => expect(screen.getByText('open (40000)')).toBeInTheDocument())
    expect(screen.getByText('+39999 more')).toBeInTheDocument()
    expect(screen.getByText('No status (7)')).toBeInTheDocument()
    // Every column request carries the search bar's filters.
    expect(listPage).toHaveBeenCalledWith('deals', expect.objectContaining({ search: { name: 'ac' }, filter: { status: 'open' } }))
    expect(listPage).toHaveBeenCalledWith('deals', expect.objectContaining({ empty: ['status'] }))
  })
})
