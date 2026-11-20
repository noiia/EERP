import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'

// React Flow stubbed as in diagram-canvas.test.tsx, but drawing each node through
// its nodeTypes component so the boxes (chevrons, footers, labels) are on screen.
type RfNode = { id: string; type: string; data: unknown; position: { x: number; y: number }; height?: number; draggable?: boolean; selectable?: boolean; connectable?: boolean; targetPosition?: string }
type RfEdge = { id: string; source: string; target: string; markerEnd?: unknown; deletable?: boolean; reconnectable?: boolean; type?: string; sourceHandle?: string }
type RfProps = {
  nodes: RfNode[]
  edges: RfEdge[]
  nodeTypes: Record<string, ComponentType<{ id: string; data: unknown; positionAbsoluteX?: number; positionAbsoluteY?: number }>>
  onNodeDragStop?: (e: unknown, n: RfNode) => void
  onConnect?: (c: { source: string; target: string }) => void
  onEdgesDelete?: (e: RfEdge[]) => void
  onReconnect?: (old: RfEdge, c: { source: string; target: string }) => void
  children?: ReactNode
}
// The camera (zoom, pan, pane size) is a small subscribable store, like React Flow's own.
const rf = vi.hoisted(() => ({
  props: null as unknown as RfProps,
  zoom: 1,
  pan: [0, 0],
  pane: { width: 0, height: 0 },
  listeners: new Set<() => void>(),
  move(pan: number[]) {
    this.pan = pan
    this.listeners.forEach((l) => l())
  },
}))
vi.mock('@xyflow/react', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    ReactFlow: (props: RfProps) => {
      rf.props = props
      return (
        <div data-testid="react-flow">
          <div className="react-flow__viewport" />
          {props.nodes.map((n) => {
            const C = props.nodeTypes[n.type]
            return <div key={n.id} data-testid={`node-${n.id}`}><C id={n.id} data={n.data} positionAbsoluteX={n.position.x} positionAbsoluteY={n.position.y} /></div>
          })}
        </div>
      )
    },
    Background: () => null,
    Controls: () => null,
    Panel: ({ children }: { children?: React.ReactNode }) => children,
    Handle: () => null,
    useStore: (select: (s: { transform: [number, number, number]; width: number; height: number }) => unknown) =>
      useSyncExternalStore(
        (l: () => void) => {
          rf.listeners.add(l)
          return () => rf.listeners.delete(l)
        },
        () => select({ transform: [rf.pan[0], rf.pan[1], rf.zoom], ...rf.pane }),
      ),
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    MarkerType: { ArrowClosed: 'arrowclosed' },
    getNodesBounds: () => ({ x: 0, y: 0, width: 100, height: 50 }),
  }
})
const exportPng = vi.hoisted(() => vi.fn(async () => {}))
const exportPdf = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('./export', () => ({ exportPng, exportPdf }))
const push = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

import { WbsRenderer, type WbsRendererProps } from './wbs-renderer'
import { LABEL_BOX_SIZE, TASK_BOX_SIZE } from './task-box'
import { DELIVERABLE_BOX_SIZE } from './deliverable-box'
import { RelationOpsProvider, type RelationOps } from '../relation-ops'
import { ApiError } from '../../api/errors'
import type { ViewDescriptor } from '../descriptor'
import type { EntityActions } from '../stores'
import { useSessionStore } from '../session-store'
import { moduleRegistry } from '../../registry'
import { setViewportWidth } from '../../test/viewport'

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
  const saveViewLayout = vi.fn(async () => {}) as unknown as (entity: string, mode: string, layout: { positions: Record<string, unknown> }) => Promise<void>
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
  rf.pan = [0, 0]
  rf.pane = { width: 0, height: 0 }
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

  it('stacks level-3 tasks under their parent, joined by elbows from its left side', async () => {
    setup(undefined, true, {
      initialData: [...rows(), { id: 'E', name: 'Wireframes', parent_id: 'B', project_id: 'p1', planned_hours: 1 }, { id: 'F', name: 'Icons', parent_id: 'B', project_id: 'p1', planned_hours: 1 }],
    })
    await waitFor(() => expect(rf.props.nodes.map((n) => n.id)).toContain('E'))
    const edge = (target: string) => rf.props.edges.find((e) => e.target === target)!
    expect(edge('E')).toMatchObject({ source: 'B', type: 'step', sourceHandle: 'stack' })
    expect(edge('F')).toMatchObject({ source: 'B', type: 'step', sourceHandle: 'stack' })
    // Levels 1 and 2 keep the plain top-down lines.
    expect(edge('B').type).toBeUndefined()
    expect(rf.props.nodes.find((n) => n.id === 'E')!.targetPosition).toBe('left')
    expect(rf.props.nodes.find((n) => n.id === 'B')!.targetPosition).toBe('top')
    const at = (id: string) => rf.props.nodes.find((n) => n.id === id)!.position
    expect(at('E').x).toBe(at('F').x)
    expect(at('F').y).toBeGreaterThan(at('E').y)
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

  it('the Layers menu folds and unfolds whole levels, which the saved layout keeps', async () => {
    const { saveViewLayout } = setup(undefined, true, {
      initialData: [...rows(), { id: 'E', name: 'Wireframes', parent_id: 'B', project_id: 'p1', planned_hours: 1 }],
    })
    await waitFor(() => expect(rf.props.nodes.map((n) => n.id)).toContain('E'))
    fireEvent.click(screen.getByRole('button', { name: 'Layers' }))
    const menu = screen.getByTestId('wbs-layers-menu')
    const item = (name: string) => within(menu).getByRole('menuitem', { name })
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Layer X', 'Layer X.Y', 'Layer X.Y.Z'])
    fireEvent.click(item('Layer X.Y'))
    expect(screen.queryByTestId('node-B')).toBeNull()
    expect(screen.getByTestId('node-A')).toBeInTheDocument()
    expect(within(item('Layer X.Y.Z')).getByRole('checkbox')).not.toBeChecked()
    await waitFor(() => expect(saveViewLayout).toHaveBeenCalledWith('project_task', 'wbs', expect.objectContaining({ folded: ['A'] })), { timeout: 2000 })
    fireEvent.click(item('Layer X.Y.Z'))
    expect(screen.getByTestId('node-E')).toBeInTheDocument()
    fireEvent.click(item('Layer X'))
    expect(screen.queryByTestId('node-A')).toBeNull()
    expect(screen.queryByTestId('node-C')).toBeNull()
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

  it('inserts a lone task dropped on a parent line, and undoes it', async () => {
    const { actions } = setup()
    await screen.findByTestId('node-D')
    // Centered between A's bottom and B's top: on the A → B line, over no box.
    const onLine = () => {
      const a = node('A').position
      const b = node('B').position
      return { x: (a.x + b.x) / 2, y: (a.y + TASK_BOX_SIZE.h + b.y) / 2 - TASK_BOX_SIZE.h / 2 }
    }
    // Another group's task never goes in.
    act(() => rf.props.onNodeDragStop!(null, { ...node('C'), position: onLine() }))
    expect(actions.update).not.toHaveBeenCalled()
    act(() => rf.props.onNodeDragStop!(null, { ...node('D'), position: onLine() }))
    await waitFor(() => expect(actions.update).toHaveBeenLastCalledWith('B', { parent_id: 'D' }))
    expect(actions.update).toHaveBeenCalledWith('D', { parent_id: 'A' })
    await act(async () => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await waitFor(() => expect(actions.update).toHaveBeenLastCalledWith('D', { parent_id: null }))
    expect(actions.update).toHaveBeenCalledWith('B', { parent_id: 'A' })
  })

  it('undoes and redoes a reparent', async () => {
    const { actions } = setup()
    await screen.findByTestId('node-D')
    drop('D', 'B')
    await waitFor(() => expect(rf.props.edges.map((e) => [e.source, e.target])).toContainEqual(['B', 'D']))
    await act(async () => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await waitFor(() => expect(actions.update).toHaveBeenLastCalledWith('D', { parent_id: null }))
    await act(async () => fireEvent.keyDown(window, { key: 'y', ctrlKey: true }))
    await waitFor(() => expect(actions.update).toHaveBeenLastCalledWith('D', { parent_id: 'B' }))
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
    let smallHandlesDuringExport = false
    exportPng.mockImplementationOnce(async () => {
      // The full boxes, their fields printed as text (no input to clip them).
      inputsDuringExport = screen.queryAllByTestId('export-field-name').length
      // 5px connector dots in the image (the canvas' [data-exporting] rule).
      smallHandlesDuringExport = document.querySelector('[data-exporting]') != null
    })
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Export' })) })
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Export PNG' })))
    await waitFor(() => expect(inputsDuringExport).toBe(4))
    expect(smallHandlesDuringExport).toBe(true)
    expect(document.querySelector('[data-exporting]')).toBeNull()
    await waitFor(() => expect(screen.queryAllByLabelText('Name')).toHaveLength(0))
    fireEvent.doubleClick(screen.getByText('2 - Review'))
    expect(push).toHaveBeenCalledWith(expect.stringContaining('/project/tasks/D'))
  })

  it('draws in full only the boxes in the zone around the camera, the others once it comes near', async () => {
    // A 200×200 pane at zoom 1: the zone is x and y in [-100, 300].
    rf.pane = { width: 200, height: 200 }
    setup()
    await screen.findByTestId('node-A')
    const inZone = (n: RfNode) => n.position.x + TASK_BOX_SIZE.w >= -100 && n.position.x <= 300 && n.position.y + TASK_BOX_SIZE.h >= -100 && n.position.y <= 300
    const tasks = rf.props.nodes.filter((n) => !n.id.startsWith('group:'))
    const far = (id: string) => !!within(screen.getByTestId(`node-${id}`)).queryByTestId('task-box-far')
    expect(tasks.some(inZone) && tasks.some((n) => !inZone(n))).toBe(true)
    for (const n of tasks) expect(far(n.id)).toBe(!inZone(n))
    // The camera pans over the far boxes: they load.
    const out = tasks.find((n) => !inZone(n))!
    // The boxes subscribe in a passive effect, which can still be pending after findBy resolves.
    await waitFor(() => expect(rf.listeners.size).toBeGreaterThan(0))
    act(() => rf.move([-out.position.x, -out.position.y]))
    expect(far(out.id)).toBe(false)
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
    let finish: (v: { records: ReturnType<typeof rows>; total: number }) => void = () => {}
    listPage.mockImplementationOnce(() => new Promise((r) => (finish = r)))
    act(() => rf.props.onEdgesDelete!([rf.props.edges.find((e) => e.target === 'B')!]))
    expect(actions.update).toHaveBeenCalledWith('B', { parent_id: null })
    await waitFor(() => expect(listPage).toHaveBeenCalledTimes(2))
    // The re-read runs behind the drawn diagram: no spinner, the canvas stays mounted.
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByTestId('node-B')).toBeInTheDocument()
    await act(async () => finish({ records: rows(), total: 4 }))
    expect(screen.getByTestId('node-B')).toBeInTheDocument()
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

describe('WBS milestones (deliverables)', () => {
  type MsTask = Task & { milestone_id: string | null }
  // A (level 1) carries m1, B (under A) m2, C (level 1) m3, D (level 1) none.
  const msRows = (): MsTask[] => [
    { id: 'A', name: 'Design', parent_id: null, project_id: 'p1', planned_hours: 1, milestone_id: 'm1' },
    { id: 'B', name: 'Mockups', parent_id: 'A', project_id: 'p1', planned_hours: 3, milestone_id: 'm2' },
    { id: 'C', name: 'Ops', parent_id: null, project_id: 'p2', planned_hours: 2, milestone_id: 'm3' },
    { id: 'D', name: 'Review', parent_id: null, project_id: 'p1', planned_hours: 0.333, milestone_id: null },
  ]
  type Ms = { id: string; name: string; project_id: string; task_done_count: number; task_count: number }
  const msCatalog: Record<string, Ms> = {
    m1: { id: 'm1', name: 'Spec signed', project_id: 'p1', task_done_count: 3, task_count: 4 },
    m2: { id: 'm2', name: 'Mock-ups OK', project_id: 'p1', task_done_count: 1, task_count: 2 },
    m3: { id: 'm3', name: 'Go live', project_id: 'p2', task_done_count: 2, task_count: 2 },
  }
  const config = { field: 'milestone_id', entity: 'project_milestone', formPath: '/project/milestones/:id', labelField: 'name', doneField: 'task_done_count', totalField: 'task_count' }

  function setupMs(opts: { rows?: MsTask[]; catalog?: Record<string, Ms>; reject?: boolean; deliverables?: unknown } = {}) {
    const rows = opts.rows ?? msRows()
    const catalog = opts.catalog ?? msCatalog
    const update = vi.fn(async (id: string, body: Partial<Task>) => ({ ...rows.find((r) => r.id === id)!, ...body }))
    const list = vi.fn(async (e: string, o?: { in?: Record<string, string[]> }) => {
      if (e === 'project_milestone') {
        if (opts.reject) throw new ApiError({ code: 'FORBIDDEN', message: 'boom', status: 403 })
        return (o?.in?.id ?? []).map((id) => catalog[id]).filter(Boolean)
      }
      return (o?.in?.id ?? []).map((id) => ({ id, name: projects[id] }))
    })
    const base = setup(update, true, {
      initialData: rows as Task[],
      deliverables: opts.deliverables === undefined ? config : opts.deliverables,
    } as Partial<WbsRendererProps<Task>>, { list })
    return { ...base, list }
  }
  const tile = (id: string) => rf.props.nodes.find((n) => n.id === `deliverable:${id}`)!
  const msReads = (list: ReturnType<typeof setupMs>['list']) => vi.mocked(list).mock.calls.filter(([e]) => e === 'project_milestone')
  const centered = (id: string) => node(id).position.x + TASK_BOX_SIZE.w / 2 - DELIVERABLE_BOX_SIZE.w / 2
  const ready = () => screen.findByText('Spec signed')

  it('draws a sub-task\'s milestone under it with an arrow, level-1 ones on the footer row', async () => {
    setupMs()
    await ready()
    expect(rf.props.nodes.map((n) => n.id).filter((id) => id.startsWith('deliverable:')).sort()).toEqual(['deliverable:A', 'deliverable:B', 'deliverable:C', 'deliverable:D'])
    // B's tile right under B, centered, tinted, with an arrow from B.
    expect(tile('B').position).toEqual({ x: centered('B'), y: node('B').position.y + TASK_BOX_SIZE.h + 24 })
    expect(within(screen.getByTestId('node-deliverable:B')).getByText('Mock-ups OK')).toBeInTheDocument()
    expect(within(screen.getByTestId('node-deliverable:B')).getByText('1 / 2')).toBeInTheDocument()
    expect(rf.props.edges.find((e) => e.target === 'deliverable:B')).toMatchObject({ source: 'B', deletable: false, reconnectable: false, markerEnd: { type: 'arrowclosed' } })
    // Level 1: one footer row below everything (B's tile included), aligned on each column.
    const row = tile('B').position.y + DELIVERABLE_BOX_SIZE.h + 48
    for (const id of ['A', 'C', 'D']) expect(tile(id).position).toEqual({ x: centered(id), y: row })
    expect(within(screen.getByTestId('node-deliverable:A')).getByText('Spec signed')).toBeInTheDocument()
    expect(rf.props.edges.some((e) => e.target === 'deliverable:A')).toBe(false)
    // D has none: the placeholder.
    expect(within(screen.getByTestId('node-deliverable:D')).getByText('No milestone yet for Review')).toBeInTheDocument()
    expect(within(screen.getByTestId('node-deliverable:D')).getByTestId('deliverable-box')).toHaveStyle({ borderStyle: 'dashed' })
  })

  it('reads the milestones once per set of ids, in chunks of 100', async () => {
    const { list } = setupMs()
    await ready()
    expect(msReads(list)).toHaveLength(1)
    expect(msReads(list)[0][1]).toEqual({ in: { id: ['m1', 'm2', 'm3'] }, pageSize: 3 })
    cleanup()
    const many = Array.from({ length: 150 }, (_, i) => ({ id: `t${i}`, name: `T${i}`, parent_id: null, project_id: 'p1', planned_hours: 1, milestone_id: `m${i}` }))
    const catalog = Object.fromEntries(many.map((t) => [t.milestone_id, { id: t.milestone_id, name: t.name, project_id: 'p1', task_done_count: 1, task_count: 1 }]))
    const big = setupMs({ rows: many, catalog })
    await screen.findByTestId('node-deliverable:t0')
    expect(msReads(big.list).map(([, o]) => (o as { in: { id: string[] } }).in.id.length)).toEqual([100, 50])
  })

  it('a refused read draws no tile and no error; no config draws none and reads nothing', async () => {
    setupMs({ reject: true })
    await screen.findByTestId('node-A')
    await act(() => new Promise((r) => setTimeout(r, 50)))
    expect(rf.props.nodes.find((n) => n.id.startsWith('deliverable:'))).toBeUndefined()
    expect(screen.queryByText('boom')).toBeNull()
    cleanup()
    const { list } = setupMs({ deliverables: null })
    await screen.findByTestId('node-A')
    expect(rf.props.nodes.find((n) => n.id.startsWith('deliverable:'))).toBeUndefined()
    expect(msReads(list)).toHaveLength(0)
  })

  it('without any milestone, every level-1 task still gets its placeholder (no read)', async () => {
    const { list } = setupMs({ rows: msRows().map((r) => ({ ...r, milestone_id: null })) })
    expect(await screen.findByText('No milestone yet for Design')).toBeInTheDocument()
    expect(rf.props.nodes.some((n) => n.id === 'deliverable:B')).toBe(false)
    expect(msReads(list)).toHaveLength(0)
  })

  it('clicking a milestone opens it; the placeholder opens the creation form linked to its task', async () => {
    setupMs()
    await ready()
    fireEvent.click(screen.getByText('Mock-ups OK'))
    expect(push).toHaveBeenLastCalledWith('/app/project/milestones/m2')
    fireEvent.click(screen.getByText('No milestone yet for Review'))
    const url = new URL(`http://eerp${String(push.mock.calls.at(-1)![0])}`)
    expect(url.pathname).toBe('/app/project/milestones/new')
    expect(url.searchParams.get('filter[project_id]')).toBe('p1')
    expect(url.searchParams.get('link')).toBe('project_task:D:milestone_id')
  })

  it('draws the tiles on a phone, and a tap opens the milestone', async () => {
    setViewportWidth(390)
    try {
      setupMs()
      await ready()
      fireEvent.click(screen.getByText('Spec signed'))
      expect(push).toHaveBeenLastCalledWith('/app/project/milestones/m1')
    } finally {
      setViewportWidth(1280)
    }
  })

  it('tiles are never dragged, selected or saved, and follow their task', async () => {
    const { saveViewLayout } = setupMs()
    await ready()
    expect(tile('B').draggable).toBe(false)
    expect(tile('B').selectable).toBe(false)
    act(() => rf.props.onNodeDragStop!(null, { ...node('A'), position: { x: node('A').position.x + 3000, y: node('A').position.y } }))
    await waitFor(() => expect(tile('A').position.x).toBe(centered('A')))
    await waitFor(() => {
      const saved = vi.mocked(saveViewLayout).mock.calls.find(([, , l]) => l.positions && Object.keys(l.positions).includes('A'))
      expect(saved).toBeTruthy()
      expect(Object.keys(saved![2].positions).some((k) => k.startsWith('deliverable:'))).toBe(false)
    }, { timeout: 2000 })
  })
})
