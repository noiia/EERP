import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'

// React Flow stubbed as in diagram-canvas.test.tsx, but drawing each node through
// its nodeTypes component so the boxes (chevrons, footers, labels) are on screen.
type RfNode = { id: string; type: string; data: unknown; position: { x: number; y: number } }
type RfEdge = { id: string; source: string; target: string; markerEnd?: unknown }
type RfProps = {
  nodes: RfNode[]
  edges: RfEdge[]
  nodeTypes: Record<string, ComponentType<{ id: string; data: unknown }>>
  onNodeDragStop?: (e: unknown, n: RfNode) => void
  onConnect?: unknown
  onEdgesDelete?: unknown
  children?: ReactNode
}
const rf = vi.hoisted(() => ({ props: null as unknown as RfProps }))
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
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  getNodesBounds: () => ({ x: 0, y: 0, width: 100, height: 50 }),
}))
vi.mock('./export', () => ({ exportPng: vi.fn(), exportPdf: vi.fn() }))
const push = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

import { WbsRenderer } from './wbs-renderer'
import { RelationOpsProvider, type RelationOps } from '../relation-ops'
import { ApiError } from '../../api/errors'
import type { ViewDescriptor } from '../descriptor'
import type { EntityActions } from '../stores'
import { useSessionStore } from '../session-store'

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

function setup(update?: EntityActions<Task>['update'], write = true) {
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
  } as unknown as RelationOps
  const actions: EntityActions<Task> = {
    create: vi.fn(),
    update: update ?? vi.fn(async (id: string, body: Partial<Task>) => ({ ...rows().find((r) => r.id === id)!, ...body })),
  }
  const onRecordsChange = vi.fn()
  render(
    <RelationOpsProvider ops={ops}>
      <WbsRenderer descriptor={descriptor} initialData={rows()} actions={actions} parentField="parent_id" groupField="project_id" hoursField="planned_hours" onRecordsChange={onRecordsChange} />
    </RelationOpsProvider>,
  )
  return { actions, onRecordsChange, saveViewLayout }
}
const node = (id: string) => rf.props.nodes.find((n) => n.id === id)!
const drop = (id: string, on: string) => act(() => rf.props.onNodeDragStop!(null, { ...node(id), position: node(on).position }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('WbsRenderer', () => {
  it('renders one root per group and tasks under parents', async () => {
    setup()
    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(rf.props.nodes.map((n) => n.id)).toEqual(['group:p1', 'A', 'B', 'D', 'group:p2', 'C'])
    expect(rf.props.edges.map((e) => [e.source, e.target])).toEqual([['group:p1', 'A'], ['A', 'B'], ['group:p1', 'D'], ['group:p2', 'C']])
    expect(rf.props.edges.every((e) => e.markerEnd === undefined)).toBe(true)
    expect(rf.props.onConnect).toBeUndefined()
    expect(rf.props.onEdgesDelete).toBeUndefined()
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

  it('is read-only without the write permission', async () => {
    const { actions } = setup(undefined, false)
    await screen.findByTestId('node-D')
    expect(screen.getAllByLabelText('Name').every((i) => (i as HTMLInputElement).disabled)).toBe(true)
    const before = node('D').position
    drop('D', 'B')
    expect(actions.update).not.toHaveBeenCalled()
    expect(node('D').position).toEqual(before)
  })
})
