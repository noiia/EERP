import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

// A card click (no drag) navigates to the record's form via the App Router.
const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

import { KanbanRenderer, TOO_MANY_COLUMNS } from './kanban-renderer'
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

  it('marks a column count Go estimated (total_estimated) as approximate', async () => {
    const { RelationOpsProvider } = await import('./relation-ops')
    const listPage = vi.fn(async (_entity: string, options?: import('../api/list-options').EntityListOptions) => {
      if (options?.filter?.status === 'open') {
        return { records: [{ id: '1', name: 'Acme', status: 'open' }], total: 40_000, totalEstimated: true as const }
      }
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
          serverOptions={{}}
        />
      </RelationOpsProvider>,
    )
    await waitFor(() => expect(screen.getByText('open (≈ 40000)')).toBeInTheDocument())
    expect(screen.getByText('+≈ 39999 more')).toBeInTheDocument()
    expect(screen.getByText('No status (7)')).toBeInTheDocument()
  })
})

describe('KanbanRenderer with many2one columns', () => {
  interface Task {
    id: string
    name: string
    stage_id?: string | null
    project_id: string
    blocked?: boolean
  }
  const taskDescriptor: ViewDescriptor<Task> = {
    entity: 'task',
    viewType: 'tree',
    fields: [
      { name: 'name', label: 'Name', type: 'text' },
      { name: 'stage_id', label: 'Stage', type: 'relation', relation: { entity: 'project_stage', kind: 'many2one' } },
      { name: 'blocked', label: 'Blocked', type: 'boolean' },
    ],
    viewModeDefaults: {
      kanbanStatusField: 'stage_id',
      kanbanColumns: { orderField: 'sequence', labelField: 'name', foldField: 'closed', scopeField: 'project_id', canEdit: 'test.stages' },
      kanbanBadgeField: 'blocked',
    },
  }
  const columnsConfig = taskDescriptor.viewModeDefaults!.kanbanColumns!
  const stageRows = [
    { id: 'a-done', name: 'Done', sequence: 30, closed: true, project_id: 'A' },
    { id: 'a-new', name: 'New', sequence: 10, closed: false, project_id: 'A' },
    { id: 'a-doing', name: 'In progress', sequence: 20, closed: false, project_id: 'A' },
    { id: 'b-new', name: 'New', sequence: 10, closed: false, project_id: 'B' },
    { id: 'b-review', name: 'Review', sequence: 15, closed: false, project_id: 'B' },
  ]
  const tasks: Task[] = [
    { id: 't1', name: 'Write spec', stage_id: 'a-new', project_id: 'A' },
    { id: 't2', name: 'Ship it', stage_id: 'a-done', project_id: 'A', blocked: true },
    { id: 't3', name: 'Loose end', stage_id: null, project_id: 'A' },
    { id: 't4', name: 'Review it', stage_id: 'b-review', project_id: 'B' },
  ]

  type Opts = import('../api/list-options').EntityListOptions
  function matches(row: Record<string, unknown>, o?: Opts): boolean {
    for (const [k, v] of Object.entries(o?.filter ?? {})) if (String(row[k]) !== v) return false
    for (const [k, v] of Object.entries(o?.in ?? {})) if (!v.includes(String(row[k]))) return false
    for (const k of o?.empty ?? []) if (row[k] != null && row[k] !== '') return false
    return true
  }

  let stageStore: Record<string, unknown>[]
  let ops: import('./relation-ops').RelationOps & {
    listPage: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
  let taskUpdate: ReturnType<typeof vi.fn<(id: string, body: Partial<Task>) => Promise<Task>>>
  let allow: boolean

  beforeEach(async () => {
    stageStore = stageRows.map((s) => ({ ...s }))
    allow = true
    const { registerKanbanColumnsGuard } = await import('./kanban-columns')
    // The guard is handed the board's RelationOps (to ask the server).
    registerKanbanColumnsGuard('test.stages', async (_scope, guardOps) => allow && typeof guardOps?.get === 'function')
    const listPage = vi.fn(async (entity: string, o?: Opts) => {
      let rows = (entity === 'project_stage' ? stageStore : (tasks as unknown as Record<string, unknown>[])).filter((r) => matches(r, o))
      if (entity === 'project_stage' && o?.pageSize) rows = rows.slice(((o.page ?? 1) - 1) * o.pageSize, (o.page ?? 1) * o.pageSize)
      return { records: rows as import('./relation-ops').RelationRecord[], total: rows.length }
    })
    const create = vi.fn(async (_entity: string, body: Record<string, unknown>) => {
      const row = { id: `new-${stageStore.length}`, ...body }
      stageStore.push(row)
      return row as import('./relation-ops').RelationRecord
    })
    const update = vi.fn(async (_entity: string, id: string, body: Record<string, unknown>) => ({ id, ...body }))
    ops = { list: vi.fn(), get: vi.fn(), remove: vi.fn(), listPage, create, update }
    taskUpdate = vi.fn(async (id: string, body: Partial<Task>) => ({ id, ...body }) as Task)
  })

  async function renderBoard(props: { serverOptions?: Opts; initialData?: Task[] } = {}) {
    const { RelationOpsProvider } = await import('./relation-ops')
    const board = (p: typeof props) => (
      <RelationOpsProvider ops={ops}>
        <KanbanRenderer
          descriptor={taskDescriptor}
          initialData={p.initialData ?? []}
          actions={{ create: vi.fn(), update: taskUpdate }}
          statusField="stage_id"
          columnsConfig={columnsConfig}
          badgeField="blocked"
          serverOptions={p.serverOptions}
        />
      </RelationOpsProvider>
    )
    const view = render(board(props))
    return { rerender: (next: typeof props) => view.rerender(board(next)) }
  }
  const groupNames = () => screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))

  it('builds columns from many2one records in orderField order', async () => {
    await renderBoard({ serverOptions: { filter: { project_id: 'A' } } })
    await waitFor(() => expect(groupNames()).toEqual(['New', 'In progress', 'Done', 'No status']))
    expect(ops.listPage).toHaveBeenCalledWith('project_stage', expect.objectContaining({ order: 'sequence', filter: { project_id: 'A' } }))
    await waitFor(() => expect(screen.getByRole('group', { name: 'New' })).toHaveTextContent('Write spec'))
    expect(ops.listPage).toHaveBeenCalledWith('task', expect.objectContaining({ filter: { project_id: 'A', stage_id: 'a-new' } }))
  })

  it('pages the column records past one page instead of dropping them', async () => {
    for (let i = 0; i < 250; i++) stageStore.push({ id: `x-${i}`, name: `Extra ${i}`, sequence: 100 + i, closed: false, project_id: 'X' })
    await renderBoard({ serverOptions: {} })
    await screen.findByRole('group', { name: 'Extra 249' })
    const stageCalls = ops.listPage.mock.calls.filter(([e]) => e === 'project_stage')
    expect(stageCalls.map(([, o]) => (o as Opts).page)).toEqual([1, 2])
    expect(screen.queryByText(TOO_MANY_COLUMNS)).toBeNull()
  })

  it('stops at the ceiling and says so rather than silently dropping columns', async () => {
    for (let i = 0; i < 2100; i++) stageStore.push({ id: `x-${i}`, name: 'Bulk', sequence: 100, closed: false, project_id: 'X' })
    await renderBoard({ serverOptions: {} })
    await screen.findByText(TOO_MANY_COLUMNS)
    expect(ops.listPage.mock.calls.filter(([e]) => e === 'project_stage')).toHaveLength(10)
  })

  it('collapses fold columns', async () => {
    await renderBoard({ serverOptions: { filter: { project_id: 'A' } } })
    const done = await screen.findByRole('group', { name: 'Done' })
    await waitFor(() => expect(done).toHaveTextContent('Done (1)'))
    expect(done).not.toHaveTextContent('Ship it')
    fireEvent.click(screen.getByRole('button', { name: 'Done (1)' }))
    expect(screen.getByRole('group', { name: 'Done' })).toHaveTextContent('Ship it')
  })

  it('keeps stage-less cards in the No status column', async () => {
    await renderBoard({ serverOptions: { filter: { project_id: 'A' } } })
    await waitFor(() => expect(screen.getByRole('group', { name: 'No status' })).toHaveTextContent('Loose end'))
    expect(ops.listPage).toHaveBeenCalledWith('task', expect.objectContaining({ empty: ['stage_id'] }))
  })

  it('merges same-label columns when unscoped and refuses a drop with no matching stage', async () => {
    await renderBoard({ initialData: tasks })
    await waitFor(() => expect(groupNames()).toEqual(['New', 'Review', 'In progress', 'Done', 'No status']))
    // Project A's task into "New": the merged column resolves to A's own New.
    drag('t3', 'New')
    await waitFor(() => expect(taskUpdate).toHaveBeenCalledWith('t3', { stage_id: 'a-new' }))
    // Project A has no "Review" stage: refused, card stays put.
    drag('t1', 'Review')
    await screen.findByText('No column named Review exists for this card.')
    expect(taskUpdate).not.toHaveBeenCalledWith('t1', expect.anything())
    expect(screen.getByRole('group', { name: 'New' })).toHaveTextContent('Write spec')
  })

  it('queries a merged column with in[] over its ids', async () => {
    await renderBoard({ serverOptions: {} })
    await waitFor(() =>
      expect(ops.listPage).toHaveBeenCalledWith('task', expect.objectContaining({ in: { stage_id: ['a-new', 'b-new'] } })),
    )
    expect(ops.listPage).toHaveBeenCalledWith('task', expect.objectContaining({ filter: { stage_id: 'b-review' } }))
  })

  it('shows column controls only when the guard allows', async () => {
    allow = false
    await renderBoard({ serverOptions: { filter: { project_id: 'A' } } })
    await screen.findByRole('group', { name: 'New' })
    await waitFor(() => expect(ops.listPage).toHaveBeenCalledTimes(5))
    expect(screen.queryByRole('textbox', { name: 'Add column' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Rename column New' })).toBeNull()
  })

  it('hides column controls on an unscoped board even when the guard allows', async () => {
    await renderBoard({ initialData: tasks })
    await screen.findByRole('group', { name: 'Review' })
    expect(screen.queryByRole('textbox', { name: 'Add column' })).toBeNull()
  })

  it('adds/renames/reorders columns through relationOps', async () => {
    await renderBoard({ serverOptions: { filter: { project_id: 'A' } } })
    const add = await screen.findByRole('textbox', { name: 'Add column' })
    fireEvent.change(add, { target: { value: 'Blocked' } })
    fireEvent.keyDown(add, { key: 'Enter' })
    await waitFor(() =>
      expect(ops.create).toHaveBeenCalledWith('project_stage', { name: 'Blocked', sequence: 40, project_id: 'A' }),
    )
    await screen.findByRole('group', { name: 'Blocked' })

    fireEvent.click(screen.getByRole('button', { name: 'Rename column New' }))
    const rename = screen.getByRole('textbox', { name: 'Column name' })
    fireEvent.change(rename, { target: { value: 'Todo' } })
    fireEvent.keyDown(rename, { key: 'Enter' })
    await waitFor(() => expect(ops.update).toHaveBeenCalledWith('project_stage', 'a-new', { name: 'Todo' }))
    await screen.findByRole('group', { name: 'Todo' })

    // Drag the Done header before Todo: every column gets 10, 20, ...
    fireEvent.dragStart(screen.getByTestId('kanban-column-header-a-done'))
    const todo = screen.getByRole('group', { name: 'Todo' })
    fireEvent.dragOver(todo)
    fireEvent.drop(todo)
    await waitFor(() => expect(groupNames()).toEqual(['Done', 'Todo', 'In progress', 'Blocked', 'No status']))
    expect(ops.update).toHaveBeenCalledWith('project_stage', 'a-done', { sequence: 10 })
    expect(ops.update).toHaveBeenCalledWith('project_stage', 'a-new', { sequence: 20 })
    expect(ops.update).toHaveBeenCalledWith('project_stage', 'a-doing', { sequence: 30 })
    expect(taskUpdate).not.toHaveBeenCalled()
  })

  it('surfaces a refused column write and reverts the reorder', async () => {
    await renderBoard({ serverOptions: { filter: { project_id: 'A' } } })
    await screen.findByRole('textbox', { name: 'Add column' })
    ops.update.mockRejectedValue(new ApiError({ code: 'FORBIDDEN', message: 'no', status: 403 }))
    fireEvent.dragStart(screen.getByTestId('kanban-column-header-a-done'))
    fireEvent.drop(screen.getByRole('group', { name: 'New' }))
    await screen.findByText('FORBIDDEN')
    expect(groupNames()).toEqual(['New', 'In progress', 'Done', 'No status'])
  })

  it('drops the previous scope\'s columns and edit right as soon as the scope changes', async () => {
    const { rerender } = await renderBoard({ serverOptions: { filter: { project_id: 'A' } } })
    await screen.findByRole('textbox', { name: 'Add column' })
    allow = false
    ops.listPage.mockClear()
    rerender({ serverOptions: { filter: { project_id: 'B' } } })
    // Same render: A's columns and controls are gone before B's arrive.
    expect(groupNames()).toEqual(['No status'])
    expect(screen.queryByRole('textbox', { name: 'Add column' })).toBeNull()
    await waitFor(() => expect(groupNames()).toEqual(['New', 'Review', 'No status']))
    expect(screen.queryByRole('textbox', { name: 'Add column' })).toBeNull()
    // No card query ever mixed B's filter with A's stage ids.
    const aIds = ['a-new', 'a-doing', 'a-done']
    for (const [entity, o] of ops.listPage.mock.calls as [string, Opts][]) {
      if (entity !== 'task') continue
      expect(aIds).not.toContain(o.filter?.stage_id)
    }
  })

  it('re-reads the columns only once every reorder PUT has settled, and shows a partial failure', async () => {
    await renderBoard({ serverOptions: { filter: { project_id: 'A' } } })
    await screen.findByRole('textbox', { name: 'Add column' })
    let finishDone!: () => void
    ops.update.mockImplementation(async (_e: string, id: string) => {
      if (id === 'a-new') throw new ApiError({ code: 'FORBIDDEN', message: 'no', status: 403 })
      if (id === 'a-done') await new Promise<void>((r) => (finishDone = r))
      return { id }
    })
    const stageReads = () => ops.listPage.mock.calls.filter(([e]) => e === 'project_stage').length
    const readsBefore = stageReads()
    fireEvent.dragStart(screen.getByTestId('kanban-column-header-a-done'))
    fireEvent.drop(screen.getByRole('group', { name: 'New' }))
    await waitFor(() => expect(ops.update).toHaveBeenCalledTimes(3))
    await new Promise((r) => setTimeout(r, 20))
    // a-new already failed, a-done is still in flight: nothing reverted or re-read yet.
    expect(screen.queryByText('FORBIDDEN')).toBeNull()
    expect(stageReads()).toBe(readsBefore)
    finishDone()
    await screen.findByText('FORBIDDEN')
    expect(groupNames()).toEqual(['New', 'In progress', 'Done', 'No status'])
    await waitFor(() => expect(stageReads()).toBe(readsBefore + 1))
  })

  it('a cancelled or already-committed rename sends no (second) PUT', async () => {
    await renderBoard({ serverOptions: { filter: { project_id: 'A' } } })
    await screen.findByRole('textbox', { name: 'Add column' })
    fireEvent.click(screen.getByRole('button', { name: 'Rename column New' }))
    let input = screen.getByRole('textbox', { name: 'Column name' })
    fireEvent.change(input, { target: { value: 'Nope' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input)
    expect(ops.update).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Rename column New' }))
    input = screen.getByRole('textbox', { name: 'Column name' })
    fireEvent.change(input, { target: { value: 'Todo' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    await waitFor(() => expect(ops.update).toHaveBeenCalledTimes(1))
  })

  it('shows the badge chip when kanbanBadgeField is true', async () => {
    await renderBoard({ initialData: tasks })
    await screen.findByRole('group', { name: 'Done' })
    fireEvent.click(screen.getByRole('button', { name: 'Done (1)' }))
    expect(screen.getByTestId('kanban-card-t2')).toHaveTextContent('Blocked')
    expect(screen.getByTestId('kanban-card-t1')).not.toHaveTextContent('Blocked')
  })
})
