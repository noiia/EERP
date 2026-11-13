import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'

// React Flow stubbed as in diagram-canvas.test.tsx, but drawing each node through
// its nodeTypes component so the boxes (chevrons, footers, labels) are on screen.
type RfNode = { id: string; type: string; data: unknown; position: { x: number; y: number }; height?: number }
type RfEdge = { id: string; source: string; target: string; markerEnd?: unknown; deletable?: boolean; reconnectable?: boolean }
type RfProps = {
  nodes: RfNode[]
  edges: RfEdge[]
  nodeTypes: Record<string, ComponentType<{ id: string; data: unknown }>>
  onNodeDragStop?: (e: unknown, n: RfNode) => void
  onConnect?: (c: { source: string; target: string }) => void
  onEdgesDelete?: (e: RfEdge[]) => void
  onReconnect?: (old: RfEdge, c: { source: string; target: string }) => void
  children?: ReactNode
}
const rf = vi.hoisted(() => ({ props: null as unknown as RfProps, zoom: 1 }))
vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: RfProps) => {
    rf.props = props
    return (
      <div data-testid="react-flow">
        <div className="react-flow__viewport" />
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
const exportPng = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('./export', () => ({ exportPng, exportPdf: vi.fn() }))
const push = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

import { WbsRenderer, type WbsRendererProps } from './wbs-renderer'
import { LABEL_BOX_SIZE, TASK_BOX_SIZE } from './task-box'
import { RelationOpsProvider, type RelationOps } from '../relation-ops'
import { ApiError } from '../../api/errors'
import type { ViewDescriptor } from '../descriptor'
import type { EntityActions } from '../stores'
import { useSessionStore } from '../session-store'
import { moduleRegistry } from '../../registry'

type Task = { id: string; name: string; parent_id: string | null; project_id: string; planned_hours: number }
const descriptor: ViewDescriptor = {
  entity: 'project_task',
  viewType: 'tree',
  formPath: '/project/tasks/:id',
  fields: [
    { name: 'name', label: 'Name', type: 'text' },
    { name: 'parent_id', label: 'Parent', type: 'relation', relation: { entity: 'project_task', kind: 'many2one' } },
    { name: 'project_id', label: 'Project', type: 'relation', relation: { entity: 'project', kind: 'many2one' } },
    { name: 'planned_hours', label: 'Planned', type: 'number' },
  ],
}
const rows = (): Task[] => [
  { id: 'A', name: 'Design', parent_id: null, project_id: 'p1', planned_hours: 1 },
  { id: 'B', name: 'Mockups', parent_id: 'A', project_id: 'p1', planned_hours: 3 },
  { id: 'C', name: 'Ops', parent_id: null, project_id: 'p2', planned_hours: 2 },
  { id: 'D', name: 'Review', parent_id: null, project_id: 'p1', planned_hours: 0.333 },
]
const projects: Record<string, string> = { p1: 'Alpha', p2: 'Beta' }

function setup(update?: EntityActions<Task>['update'], write = true, extra: Partial<WbsRendererProps<Task>> = {}, opsOver: Partial<RelationOps> = {}) {
  useSessionStore.setState({
    identity: { userId: 'u1', tenantId: 't1', roles: [], permissions: write ? ['project_task:project_task:read', 'project_task:project_task:write'] : ['project_task:project_task:read'] },
  } as never)
  const saveViewLayout = vi.fn(async () => {})
  const ops: RelationOps = {
    list: vi.fn(async (_e: string, o?: { in?: Record<string, string[]> }) => (o?.in?.id ?? []).map((id) => ({ id, name: projects[id] }))),
    get: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
    getViewLayout: async () => ({ positions: {}, folded: [] }),
    saveViewLayout,
    ...opsOver,
  } as unknown as RelationOps
  const actions: EntityActions<Task> = {
    create: vi.fn(),
    update: update ?? vi.fn(async (id: string, body: Partial<Task>) => ({ ...rows().find((r) => r.id === id)!, ...body })),
  }
  const onRecordsChange = vi.fn()
  render(
    <RelationOpsProvider ops={ops}>
      <WbsRenderer descriptor={descriptor} initialData={rows()} actions={actions} parentField="parent_id" groupField="project_id" hoursField="planned_hours" onRecordsChange={onRecordsChange} {...extra} />
    </RelationOpsProvider>,
  )
  return { actions, onRecordsChange, saveViewLayout, ops }
}
const node = (id: string) => rf.props.nodes.find((n) => n.id === id)!
// Drops `id` centered on `on`, as a user does (the canvas checks where the dropped box's center lands).
const drop = (id: string, on: string) => {
  const h = (n: RfNode) => n.height ?? TASK_BOX_SIZE.h
  const target = node(on)
  const position = { x: target.position.x, y: target.position.y + h(target) / 2 - h(node(id)) / 2 }
  return act(() => rf.props.onNodeDragStop!(null, { ...node(id), position }))
}

afterEach(() => {
  rf.zoom = 1
  cleanup()
  vi.clearAllMocks()
})

describe('WbsRenderer', () => {
  it('spaces rows evenly under a short group root', async () => {
    setup()
    await screen.findByText('Alpha')
    const at = (id: string) => rf.props.nodes.find((n) => n.id === id)!
    const g = at('group:p1'), a = at('A'), b = at('B')
    expect(g.height).toBe(LABEL_BOX_SIZE.h)
    expect(a.position.y - (g.position.y + LABEL_BOX_SIZE.h)).toBe(b.position.y - (a.position.y + TASK_BOX_SIZE.h))
  })

  it('renders one root per group and tasks under parents', async () => {
    setup()
    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(rf.props.nodes.map((n) => n.id)).toEqual(['group:p1', 'A', 'B', 'D', 'group:p2', 'C'])
    expect(rf.props.edges.map((e) => [e.source, e.target])).toEqual([['group:p1', 'A'], ['A', 'B'], ['group:p1', 'D'], ['group:p2', 'C']])
    expect(rf.props.edges.every((e) => e.markerEnd === undefined)).toBe(true)
    expect(rf.props.edges.map((e) => e.deletable && e.reconnectable)).toEqual([false, true, false, false])
    expect(screen.getAllByLabelText('Name').map((i) => (i as HTMLInputElement).value)).toEqual(['Design', 'Mockups', 'Review', 'Ops'])
    fireEvent.doubleClick(screen.getByTestId('node-A').firstElementChild!)
    expect(push).toHaveBeenCalledWith(expect.stringContaining('/project/tasks/A'))
  })

  it('chevron folds and saves folded ids', async () => {
    const { saveViewLayout } = setup()
    await screen.findByTestId('node-A')
    fireEvent.click(screen.getAllByRole('button', { name: 'Collapse' })[1])
    expect(screen.queryByTestId('node-B')).toBeNull()
    expect(screen.getByText('+1 task · 3 h')).toBeInTheDocument()
    await waitFor(() => expect(saveViewLayout).toHaveBeenCalledWith('project_task', 'wbs', expect.objectContaining({ folded: ['A'] })), { timeout: 2000 })
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    expect(screen.getByTestId('node-B')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Collapse' })[0])
    expect(screen.getByText('+3 tasks · 4.33 h')).toBeInTheDocument()
  })

  it('edits a field in the box', async () => {
    const { actions, onRecordsChange } = setup()
    await screen.findByTestId('node-A')
    const input = screen.getAllByLabelText('Name')[0]
    fireEvent.change(input, { target: { value: 'Plan' } })
    fireEvent.blur(input)
    expect(actions.update).toHaveBeenCalledWith('A', { name: 'Plan' })
    await waitFor(() => expect(onRecordsChange).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'A', name: 'Plan' })])))
  })

  it('reparents on drop', async () => {
    const { actions, onRecordsChange } = setup()
    await screen.findByTestId('node-D')
    drop('D', 'B')
    expect(actions.update).toHaveBeenCalledWith('D', { parent_id: 'B' })
    await waitFor(() => expect(onRecordsChange).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'D', parent_id: 'B' })])))
    expect(rf.props.edges.map((e) => [e.source, e.target])).toContainEqual(['B', 'D'])
  })

  it('with order numbers, a drop writes the number it lands at', async () => {
    const numbered = { A: '1', B: '1.1', D: '2', C: '1' } as Record<string, string>
    const { actions } = setup(undefined, true, {
      orderField: 'wbs_number',
      initialData: rows().map((r) => ({ ...r, wbs_number: numbered[r.id] })) as Task[],
    })
    await screen.findByTestId('node-D')
    // D before A in the drawn order: D numbered 2 stays after A numbered 1.
    expect(rf.props.nodes.map((n) => n.id)).toEqual(['group:p1', 'A', 'B', 'D', 'group:p2', 'C'])
    drop('D', 'A') // on A, level with its only child B: first under A
    expect(actions.update).toHaveBeenLastCalledWith('D', { wbs_number: '1.1' })
    // Empty space left of A: first among the top-level tasks.
    act(() => rf.props.onNodeDragStop!(null, { ...node('D'), position: { x: -5000, y: -5000 } }))
    expect(actions.update).toHaveBeenLastCalledWith('D', { wbs_number: '1' })
    vi.mocked(actions.update).mockClear()
    // Empty space right of A: still second, nothing written.
    act(() => rf.props.onNodeDragStop!(null, { ...node('D'), position: { x: 5000, y: -5000 } }))
    expect(actions.update).not.toHaveBeenCalled()
  })

  it('drop on a group root clears the parent', async () => {
    const { actions } = setup()
    await screen.findByTestId('node-B')
    drop('B', 'group:p1')
    expect(actions.update).toHaveBeenCalledWith('B', { parent_id: null })
  })

  it('refuses a drop on a descendant', async () => {
    const { actions } = setup()
    await screen.findByTestId('node-B')
    const before = node('A').position
    drop('A', 'B')
    drop('B', 'A') // already its parent: nothing to do
    expect(actions.update).not.toHaveBeenCalled()
    expect(node('A').position).toEqual(before)
  })

  it('reverts on a rejected reparent', async () => {
    const update = vi.fn(async () => {
      throw new ApiError({ code: 'VALIDATION_ERROR', message: 'cycle', status: 422 })
    })
    const { onRecordsChange } = setup(update)
    await screen.findByTestId('node-D')
    const before = node('D').position
    drop('D', 'B')
    expect(await screen.findByText('cycle')).toBeInTheDocument()
    expect(onRecordsChange).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'D', parent_id: null })]))
    await waitFor(() => expect(node('D').position).toEqual(before))
  })

  it('refuses drops into another group, and on its own group root when already a root', async () => {
    const { actions } = setup()
    await screen.findByTestId('node-C')
    const c = node('C').position
    drop('C', 'B')
    drop('C', 'group:p1')
    expect(node('C').position).toEqual(c)
    const a = node('A').position
    drop('A', 'group:p1')
    expect(node('A').position).toEqual(a)
    expect(actions.update).not.toHaveBeenCalled()
  })

  it('resolves a many2one shown in many boxes with one read', async () => {
    const get = vi.fn(async (_e: string, id: string) => ({ id, name: projects[id] }))
    const { ops } = setup(undefined, true, { boxFields: ['name', 'project_id'] }, { get })
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2)) // p1 once for 3 boxes, p2 once
    await act(() => new Promise((r) => setTimeout(r, 50)))
    expect(get).toHaveBeenCalledTimes(2)
    expect(ops.get).toBe(get)
  })

  it('takes box fields from the form descriptor first (its relation scoping)', async () => {
    const formStage = { name: 'project_id', label: 'Project', type: 'relation' as const, relation: { entity: 'project', kind: 'many2one' as const, filterFields: { company_id: 'name' } } }
    const spy = vi.spyOn(moduleRegistry, 'formDescriptorFor').mockReturnValue({ ...descriptor, viewType: 'form', fields: [{ name: 'name', label: 'Title', type: 'text' }, formStage] })
    setup(undefined, true, { boxFields: ['name'] })
    expect(await screen.findAllByLabelText('Title')).toHaveLength(4)
    expect(screen.queryByLabelText('Name')).toBeNull()
    spy.mockRestore()
  })

  it('shows a spinner while the records load', async () => {
    setup(undefined, true, { serverOptions: {} }, { listPage: vi.fn(() => new Promise<never>(() => {})) })
    expect(await screen.findByRole('progressbar')).toBeInTheDocument()
    expect(screen.queryByTestId('react-flow')).toBeNull()
  })

  it('zoomed out, boxes show only "<order> - <name>"; an export still gets the full boxes', async () => {
    const numbered = { A: '1', B: '1.1', D: '2', C: '1' } as Record<string, string>
    rf.zoom = 0.3
    setup(undefined, true, { orderField: 'wbs_number', initialData: rows().map((r) => ({ ...r, wbs_number: numbered[r.id] })) as Task[] })
    await screen.findByText('1.1 - Mockups')
    expect(screen.getAllByTestId('task-box-far')).toHaveLength(4)
    expect(screen.queryAllByLabelText('Name')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Collapse' })).toBeNull()
    let inputsDuringExport = -1
    exportPng.mockImplementationOnce(async () => {
      inputsDuringExport = screen.queryAllByLabelText('Name').length
    })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Export PNG' })))
    expect(inputsDuringExport).toBe(4)
    await waitFor(() => expect(screen.queryAllByLabelText('Name')).toHaveLength(0))
    fireEvent.doubleClick(screen.getByText('2 - Review'))
    expect(push).toHaveBeenCalledWith(expect.stringContaining('/project/tasks/D'))
  })

  it('is read-only without the write permission', async () => {
    const { actions } = setup(undefined, false)
    await screen.findByTestId('node-D')
    expect(screen.getAllByLabelText('Name').every((i) => (i as HTMLInputElement).disabled)).toBe(true)
    const before = node('D').position
    drop('D', 'B')
    expect(actions.update).not.toHaveBeenCalled()
    expect(node('D').position).toEqual(before)
    expect(rf.props.onConnect).toBeUndefined()
    expect(rf.props.onEdgesDelete).toBeUndefined()
    expect(rf.props.onReconnect).toBeUndefined()
    expect(rf.props.edges.some((e) => e.deletable || e.reconnectable)).toBe(false)
  })

  it('a drawn link makes the source the parent, and refuses cycles, other groups and group targets', async () => {
    const { actions, onRecordsChange } = setup()
    await screen.findByTestId('node-D')
    act(() => rf.props.onConnect!({ source: 'B', target: 'A' })) // B is A's child
    act(() => rf.props.onConnect!({ source: 'C', target: 'D' })) // another project
    act(() => rf.props.onConnect!({ source: 'A', target: 'group:p1' }))
    act(() => rf.props.onConnect!({ source: 'A', target: 'B' })) // already its parent
    expect(actions.update).not.toHaveBeenCalled()
    act(() => rf.props.onConnect!({ source: 'B', target: 'D' }))
    expect(actions.update).toHaveBeenCalledWith('D', { parent_id: 'B' })
    await waitFor(() => expect(rf.props.edges.map((e) => [e.source, e.target])).toContainEqual(['B', 'D']))
    expect(onRecordsChange).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'D', parent_id: 'B' })]))
  })

  it('deleting a link clears the parent, and re-reads the renumbered records', async () => {
    const listPage = vi.fn(async () => ({ records: rows(), total: 4 }))
    const { actions } = setup(undefined, true, { serverOptions: {}, orderField: 'wbs_number' }, { listPage })
    await screen.findByTestId('node-B')
    expect(listPage).toHaveBeenCalledTimes(1)
    act(() => rf.props.onEdgesDelete!([rf.props.edges.find((e) => e.target === 'B')!]))
    expect(actions.update).toHaveBeenCalledWith('B', { parent_id: null })
    await waitFor(() => expect(listPage).toHaveBeenCalledTimes(2))
  })

  it('moving a link end re-parents: the new child takes it, the old child loses it', async () => {
    const { actions } = setup()
    await screen.findByTestId('node-B')
    const ab = rf.props.edges.find((e) => e.target === 'B')!
    act(() => rf.props.onReconnect!(ab, { source: 'A', target: 'D' }))
    await waitFor(() => expect(actions.update).toHaveBeenCalledWith('B', { parent_id: null }))
    expect(vi.mocked(actions.update).mock.calls).toEqual([['D', { parent_id: 'A' }], ['B', { parent_id: null }]])
    vi.mocked(actions.update).mockClear()
    // The parent end moved: same child, new parent.
    act(() => rf.props.onReconnect!(rf.props.edges.find((e) => e.target === 'D')!, { source: 'B', target: 'D' }))
    expect(vi.mocked(actions.update).mock.calls).toEqual([['D', { parent_id: 'B' }]])
  })

  it('shows a refused link', async () => {
    const update = vi.fn(async () => {
      throw new ApiError({ code: 'VALIDATION_ERROR', message: 'nope', status: 422 })
    })
    setup(update)
    await screen.findByTestId('node-D')
    act(() => rf.props.onConnect!({ source: 'A', target: 'D' }))
    expect(await screen.findByText('nope')).toBeInTheDocument()
  })
})
