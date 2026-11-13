import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'

// React Flow stubbed as in wbs-renderer.test.tsx: each node drawn through its nodeTypes component.
type RfNode = { id: string; type: string; data: unknown; className?: string; position: { x: number; y: number } }
type RfEdge = { id: string; source: string; target: string; className?: string; markerEnd?: unknown; deletable?: boolean }
type RfProps = {
  nodes: RfNode[]
  edges: RfEdge[]
  nodeTypes: Record<string, ComponentType<{ id: string; data: unknown }>>
  onConnect?: (c: { source: string; target: string }) => void
  onEdgesDelete?: (e: RfEdge[]) => void
  children?: ReactNode
}
const rf = vi.hoisted(() => ({ props: null as unknown as RfProps, zoom: 1 }))
vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: RfProps) => {
    rf.props = props
    return (
      <div data-testid="react-flow">
        {props.nodes.map((n) => {
          const C = props.nodeTypes[n.type]
          return <div key={n.id} data-testid={`node-${n.id}`}><C id={n.id} data={n.data} /></div>
        })}
      </div>
    )
  },
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  useStore: (select: (s: { transform: [number, number, number] }) => unknown) => select({ transform: [0, 0, rf.zoom] }),
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  getNodesBounds: () => ({ x: 0, y: 0, width: 100, height: 50 }),
}))
vi.mock('./export', () => ({ exportPng: vi.fn(), exportPdf: vi.fn() }))
const push = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

import { PertRenderer } from './pert-renderer'
import type { TaskBoxData } from './task-box'
import { RelationOpsProvider, type RelationOps } from '../relation-ops'
import { ApiError } from '../../api/errors'
import type { ViewDescriptor } from '../descriptor'
import type { EntityActions } from '../stores'
import { useSessionStore } from '../session-store'
import { moduleRegistry } from '../../registry'

type Task = { id: string; name: string; planned_hours: number | null; date_start: string | null; deadline: string | null; closed?: boolean }
type Link = { id: string; depends_on_id: string; task_id: string }
const descriptor: ViewDescriptor = {
  entity: 'project_task',
  viewType: 'tree',
  formPath: '/project/tasks/:id',
  fields: [
    { name: 'name', label: 'Name', type: 'text' },
    { name: 'planned_hours', label: 'Planned', type: 'number' },
  ],
}
const dep = { entity: 'project_task_dependency', fromField: 'depends_on_id', toField: 'task_id' }
// Diamond A → B → D, A → C → D; B (2 d) is longer than C (1 d).
const diamond = (): Task[] => [
  { id: 'A', name: 'Spec', planned_hours: 8, date_start: null, deadline: null },
  { id: 'B', name: 'Build', planned_hours: 16, date_start: null, deadline: null },
  { id: 'C', name: 'Docs', planned_hours: 8, date_start: null, deadline: null, closed: true },
  { id: 'D', name: 'Ship', planned_hours: 8, date_start: null, deadline: null },
]
const diamondLinks = (): Link[] => [
  { id: 'l1', depends_on_id: 'A', task_id: 'B' },
  { id: 'l2', depends_on_id: 'A', task_id: 'C' },
  { id: 'l3', depends_on_id: 'B', task_id: 'D' },
  { id: 'l4', depends_on_id: 'C', task_id: 'D' },
]

function setup(opts: { tasks?: Task[]; links?: Link[]; write?: boolean; linkWrite?: boolean; create?: RelationOps['create']; update?: EntityActions<Task>['update']; listPage?: RelationOps['listPage']; serverOptions?: object } = {}) {
  const { tasks = diamond(), links = diamondLinks(), write = true, linkWrite = write } = opts
  useSessionStore.setState({
    identity: {
      userId: 'u1',
      tenantId: 't1',
      roles: [],
      permissions: ['project_task:project_task:read', ...(write ? ['project_task:project_task:write'] : []), ...(linkWrite ? ['project_task_dependency:project_task_dependency:write'] : [])],
    },
  } as never)
  const ops: RelationOps = {
    list: vi.fn(async () => []),
    get: vi.fn(),
    create: opts.create ?? vi.fn(async (_e: string, body: Record<string, unknown>) => ({ id: 'new', ...body })),
    remove: vi.fn(async () => {}),
    listPage: opts.listPage ?? vi.fn(async (_e: string, o?: { in?: Record<string, string[]> }) => {
      const records = links.filter((l) => o?.in?.task_id?.includes(l.task_id) || o?.in?.depends_on_id?.includes(l.depends_on_id))
      return { records, total: records.length }
    }),
    getViewLayout: async () => ({ positions: {}, folded: [] }),
    saveViewLayout: vi.fn(async () => {}),
  } as unknown as RelationOps
  const actions: EntityActions<Task> = {
    create: vi.fn(),
    update: opts.update ?? vi.fn(async (id: string, body: Partial<Task>) => ({ ...tasks.find((r) => r.id === id)!, ...body })),
  }
  const onRecordsChange = vi.fn()
  render(
    <RelationOpsProvider ops={ops}>
      <PertRenderer
        descriptor={descriptor}
        initialData={tasks}
        actions={actions}
        dependencies={dep}
        startField="date_start"
        endField="deadline"
        hoursField="planned_hours"
        boxFields={['name', 'planned_hours', 'name', 'nope']}
        onRecordsChange={onRecordsChange}
        serverOptions={opts.serverOptions}
      />
    </RelationOpsProvider>,
  )
  return { ops, actions, onRecordsChange }
}
const node = (id: string) => rf.props.nodes.find((n) => n.id === id)!
const critical = () => rf.props.nodes.filter((n) => n.className?.includes('critical')).map((n) => n.id)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('PertRenderer', () => {
  it('zoomed out, boxes show only their title', async () => {
    rf.zoom = 0.3
    try {
      setup()
      expect(await screen.findByText('Spec')).toBeInTheDocument()
      expect(screen.getAllByTestId('task-box-far')).toHaveLength(4)
      expect(screen.queryByText(/^ES /)).toBeNull()
    } finally {
      rf.zoom = 1
    }
  })

  it('highlights the critical chain', async () => {
    setup()
    await waitFor(() => expect(rf.props.edges).toHaveLength(4))
    expect(critical()).toEqual(['A', 'B', 'D'])
    expect(rf.props.edges.filter((e) => e.className?.includes('critical')).map((e) => e.id)).toEqual(['l1', 'l3'])
    expect(rf.props.edges.every((e) => e.markerEnd)).toBe(true)
    expect(node('C').className).toContain('closed')
    expect(screen.getAllByLabelText('Name').map((i) => (i as HTMLInputElement).value)).toEqual(['Spec', 'Build', 'Docs', 'Ship'])
    expect(screen.getAllByText(/^Slack/).length).toBe(4)
    fireEvent.doubleClick(screen.getByTestId('node-A').firstElementChild!)
    expect(push).toHaveBeenCalledWith(expect.stringContaining('/project/tasks/A'))
  })

  it('shows no-estimate badge', async () => {
    setup({ tasks: [...diamond(), { id: 'E', name: 'Idle', planned_hours: null, date_start: null, deadline: null }] })
    expect(await screen.findByText('No estimate')).toBeInTheDocument()
    expect(screen.getAllByText('No estimate')).toHaveLength(2) // the badge and the legend
  })

  it('shows hidden links count', async () => {
    setup({ links: [...diamondLinks(), { id: 'l9', depends_on_id: 'X', task_id: 'B' }, { id: 'l8', depends_on_id: 'D', task_id: 'Y' }] })
    expect(await screen.findByText('2 hidden links')).toBeInTheDocument()
    expect(rf.props.edges).toHaveLength(4)
  })

  it('counts a link from a shown task to a hidden one', async () => {
    setup({ links: [...diamondLinks(), { id: 'l9', depends_on_id: 'D', task_id: 'X' }] })
    expect(await screen.findByText('1 hidden link')).toBeInTheDocument()
    expect(rf.props.edges).toHaveLength(4)
  })

  it('shows a spinner while the records load', async () => {
    setup({ serverOptions: {}, listPage: vi.fn(() => new Promise<never>(() => {})) })
    expect(await screen.findByRole('progressbar')).toBeInTheDocument()
    expect(screen.queryByTestId('react-flow')).toBeNull()
  })

  it('gates arrows on the dependency entity, not the task one', async () => {
    setup({ write: false, linkWrite: true })
    await waitFor(() => expect(rf.props.edges).toHaveLength(4))
    expect(rf.props.onConnect).toBeDefined()
    expect(rf.props.edges.every((e) => e.deletable === true)).toBe(true)
    cleanup()
    const { ops } = setup({ write: true, linkWrite: false })
    await waitFor(() => expect(rf.props.edges).toHaveLength(4))
    // Still connectable for notes, but a box-to-box arrow creates nothing.
    act(() => rf.props.onConnect!({ source: 'D', target: 'A' }))
    expect(ops.create).not.toHaveBeenCalled()
  })

  it('edits a box field through the form descriptor', async () => {
    const spy = vi.spyOn(moduleRegistry, 'formDescriptorFor').mockReturnValue({ ...descriptor, viewType: 'form', fields: [{ name: 'name', label: 'Title', type: 'text' }] })
    setup()
    expect((await screen.findAllByLabelText('Title')).length).toBe(4)
    spy.mockRestore()
  })

  it('creates a dependency on connect', async () => {
    const { ops } = setup()
    await waitFor(() => expect(rf.props.edges).toHaveLength(4))
    act(() => rf.props.onConnect!({ source: 'A', target: 'A' }))
    act(() => rf.props.onConnect!({ source: 'A', target: 'B' }))
    expect(ops.create).not.toHaveBeenCalled()
    act(() => rf.props.onConnect!({ source: 'B', target: 'C' }))
    expect(ops.create).toHaveBeenCalledWith('project_task_dependency', { depends_on_id: 'B', task_id: 'C' })
    await waitFor(() => expect(rf.props.edges.map((e) => e.id)).toContain('new'))
    // B → C → D (1 + 2 + 1 + 1): C is now on the critical path.
    expect(critical()).toEqual(['A', 'B', 'C', 'D'])
  })

  it('deletes a dependency on edge delete', async () => {
    const { ops } = setup()
    await waitFor(() => expect(rf.props.edges).toHaveLength(4))
    act(() => rf.props.onEdgesDelete!([rf.props.edges.find((e) => e.id === 'l3')!]))
    expect(ops.remove).toHaveBeenCalledWith('project_task_dependency', 'l3')
    await waitFor(() => expect(rf.props.edges.map((e) => e.id)).toEqual(['l1', 'l2', 'l4']))
  })

  it('keeps the edge on a rejected delete', async () => {
    const { ops } = setup()
    vi.mocked(ops.remove).mockRejectedValueOnce(new ApiError({ code: 'FORBIDDEN', message: 'no', status: 403 }))
    await waitFor(() => expect(rf.props.edges).toHaveLength(4))
    act(() => rf.props.onEdgesDelete!([rf.props.edges[0]]))
    expect(await screen.findByText('no')).toBeInTheDocument()
    expect(rf.props.edges).toHaveLength(4)
  })

  it('reverts on a rejected link', async () => {
    const create = vi.fn(async () => {
      throw new ApiError({ code: 'VALIDATION_ERROR', message: 'cycle', status: 422 })
    })
    setup({ create })
    await waitFor(() => expect(rf.props.edges).toHaveLength(4))
    act(() => rf.props.onConnect!({ source: 'D', target: 'A' }))
    expect(await screen.findByText('cycle')).toBeInTheDocument()
    expect(rf.props.edges).toHaveLength(4)
  })

  it('recomputes after editing planned hours', async () => {
    const { actions, onRecordsChange } = setup()
    await waitFor(() => expect(critical()).toEqual(['A', 'B', 'D']))
    await act(() => (node('C').data as TaskBoxData).onCommit('planned_hours', 80))
    expect(actions.update).toHaveBeenCalledWith('C', { planned_hours: 80 })
    expect(critical()).toEqual(['A', 'C', 'D'])
    expect(onRecordsChange).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'C', planned_hours: 80 })]))
  })

  it('warns on a cycle and highlights nothing', async () => {
    setup({ links: [...diamondLinks(), { id: 'l5', depends_on_id: 'D', task_id: 'A' }] })
    expect(await screen.findByText('Dependency cycle: critical path not computed')).toBeInTheDocument()
    expect(critical()).toEqual([])
  })

  it('is read-only without the write permission', async () => {
    const { ops } = setup({ write: false })
    await waitFor(() => expect(rf.props.edges).toHaveLength(4))
    act(() => rf.props.onConnect!({ source: 'D', target: 'A' }))
    act(() => rf.props.onEdgesDelete!([rf.props.edges[0]]))
    expect(ops.create).not.toHaveBeenCalled()
    expect(ops.remove).not.toHaveBeenCalled()
    expect(rf.props.edges.every((e) => e.deletable === false)).toBe(true)
    expect(screen.getAllByLabelText('Name').every((i) => (i as HTMLInputElement).disabled)).toBe(true)
  })
})
