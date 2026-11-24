import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'

// React Flow stubbed as in obs-renderer.test.tsx: each node drawn through its nodeTypes component,
// with the viewport class the canvas export capture looks for.
type RfNode = { id: string; type: string; data: unknown; position: { x: number; y: number }; width?: number; height?: number }
type RfEdge = { id: string; source: string; target: string; type?: string; deletable?: boolean }
type RfProps = {
  onNodeDoubleClick?: (e: unknown, n: RfNode) => void
  nodes: RfNode[]
  edges: RfEdge[]
  nodeTypes: Record<string, ComponentType<{ id: string; data: unknown }>>
  onConnect?: (c: { source: string; target: string }) => void
  onEdgesDelete?: (e: RfEdge[]) => void
  onNodeDragStop?: (e: unknown, n: RfNode, dragged?: RfNode[]) => void
  nodesDraggable?: boolean
  nodesConnectable?: boolean
  children?: ReactNode
}
const rf = vi.hoisted(() => ({ props: null as unknown as RfProps }))
vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: RfProps) => {
    rf.props = props
    return (
      <div data-testid="react-flow">
        <div className="react-flow__viewport" />
        {props.nodes.map((n) => {
          const C = props.nodeTypes[n.type]
          return <div key={n.id} data-testid={`node-${n.id}`} onDoubleClick={(e) => props.onNodeDoubleClick?.(e, n)}><C id={n.id} data={n.data} /></div>
        })}
      </div>
    )
  },
  Background: () => null,
  Controls: () => null,
  Panel: ({ children }: { children?: React.ReactNode }) => children,
  Handle: () => null,
  useStore: (select: (s: { transform: [number, number, number] }) => unknown) => select({ transform: [0, 0, 1] }),
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  getNodesBounds: () => ({ x: 0, y: 0, width: 100, height: 50 }),
}))
const exportPng = vi.hoisted(() => vi.fn(async () => {}))
const exportPdf = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('./export', () => ({ exportPng, exportPdf }))
const nav = vi.hoisted(() => ({ push: vi.fn(), pathname: '/app/project/tasks' }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push }), usePathname: () => nav.pathname }))

import { PbsRenderer, PBS_BOX_SIZE } from './pbs-renderer'
import { layoutWbs } from './auto-layout'
import { buildWbs } from './wbs'
import { registerKanbanColumnsGuard } from '../kanban-columns'
import { RelationOpsProvider, type RelationOps } from '../relation-ops'
import { ApiError } from '../../api/errors'
import { setViewportWidth } from '../../test/viewport'

type Item = { id: string; project_id: string; parent_id: string | null; name: string; description: string | null; color: string | null; x: number; y: number; task_count: number; done_count: number }
type Task = { id: string; project_id: string; pbs_item_id: string | null; closed: boolean }
const item = (id: string, over: Partial<Item> = {}): Item => ({ id, project_id: 'p1', parent_id: null, name: id, description: null, color: null, x: 0, y: 0, task_count: 0, done_count: 0, ...over })
const items = (): Item[] => [
  item('i1', { name: 'Design', color: '#ff0000', x: 100, y: 50, task_count: 4, done_count: 3 }),
  item('i2', { name: 'Mock-ups', parent_id: 'i1', x: 400, y: 300, task_count: 2, done_count: 1 }),
  item('i3', { name: 'Wiring', parent_id: 'i1', x: 700, y: 300, task_count: 1, done_count: 1 }),
  item('i4', { name: 'Build', x: 1000, y: 50, task_count: 1, done_count: 0 }),
  item('i5', { name: 'Spare', x: 1300, y: 50, task_count: 0, done_count: 0 }),
]
const tasks = (): Task[] => [
  { id: 't1', project_id: 'p1', pbs_item_id: 'i2', closed: true },
  { id: 't2', project_id: 'p1', pbs_item_id: 'i2', closed: false },
  { id: 't3', project_id: 'p1', pbs_item_id: 'i3', closed: true },
  { id: 't4', project_id: 'p1', pbs_item_id: 'i4', closed: false },
  { id: 't5', project_id: 'p1', pbs_item_id: 'i1', closed: true },
]
const config = { entity: 'project_pbs_item', projectField: 'project_id', projectEntity: 'project', taskField: 'pbs_item_id', canEdit: 'test.pbs' }
const err = (status: number, message: string) => new ApiError({ code: status === 422 ? 'VALIDATION_ERROR' : 'FORBIDDEN', message, status })

function setup(opts: { items?: Item[]; tasks?: Task[]; edit?: boolean; ops?: Partial<RelationOps> } = {}) {
  const { edit = true } = opts
  let rows = opts.items ?? items()
  const taskRows = opts.tasks ?? tasks()
  let created = 0
  registerKanbanColumnsGuard('test.pbs', async () => edit)
  const ops = {
    list: vi.fn(async () => []),
    get: vi.fn(async (e: string, id: string) => {
      const r = (e === 'project_pbs_item' ? rows : []).find((x) => x.id === id)
      if (!r) throw err(404, 'not found')
      return r
    }),
    create: vi.fn(async (e: string, body: Record<string, unknown>) => {
      const r = { ...item(`new${++created}`), ...body } as Item
      if (e === 'project_pbs_item') rows = [...rows, r] // a re-created item re-appears on reload
      return r
    }),
    update: vi.fn(async (_e: string, id: string, body: Record<string, unknown>) => ({ ...rows.find((r) => r.id === id)!, ...body })),
    remove: vi.fn(async (_e: string, id: string) => {
      rows = rows.filter((r) => r.id !== id).map((r) => (r.parent_id === id ? { ...r, parent_id: null } : r))
    }),
    listPage: vi.fn(async (e: string, o: { page?: number; pageSize?: number } = {}) => {
      const all = e === 'project_pbs_item' ? rows : taskRows
      const size = o.pageSize ?? 200
      const page = all.slice(((o.page ?? 1) - 1) * size, (o.page ?? 1) * size)
      return { records: page, total: all.length }
    }),
    ...opts.ops,
  } as unknown as RelationOps & { update: ReturnType<typeof vi.fn>; listPage: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }
  render(
    <RelationOpsProvider ops={ops}>
      <PbsRenderer config={config} projectId="p1" />
    </RelationOpsProvider>,
  )
  return { ops }
}
const node = (id: string) => rf.props.nodes.find((n) => n.id === id)!
const ready = () => waitFor(() => expect(rf.props?.nodes.length).toBeGreaterThan(0))
const editable = () => screen.findByRole('button', { name: 'Add item' })

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  rf.props = null as unknown as RfProps
  setViewportWidth(1280)
})

describe('PbsRenderer', () => {
  it('loads items and tasks page by page, rolling the progress up over descendants', async () => {
    // The default items plus 196 fillers: two pages of 200, so the paging is exercised
    // without losing the i1/i2 structure the roll-up assertions use.
    const many = [...items(), ...Array.from({ length: 196 }, (_, i) => item(`x${i}`))]
    const { ops } = setup({ items: many })
    await ready()
    expect(ops.listPage).toHaveBeenCalledWith('project_pbs_item', { filter: { project_id: 'p1' }, order: 'created_at', pageSize: 200, page: 1 })
    expect(ops.listPage).toHaveBeenCalledWith('project_pbs_item', { filter: { project_id: 'p1' }, order: 'created_at', pageSize: 200, page: 2 })
    expect(ops.listPage).toHaveBeenCalledWith('project_task', { filter: { project_id: 'p1' }, order: 'wbs_number', pageSize: 200, page: 1 })
    // i2: 1/2 of its own tasks; i1: its own t5 plus the descendants' (1/2 + 1/1).
    expect(within(screen.getByTestId('node-i2')).getByText('1 / 2')).toBeInTheDocument()
    expect(within(screen.getByTestId('node-i1')).getByText('3 / 4')).toBeInTheDocument()
    cleanup()
    setup({ ops: { listPage: vi.fn(async () => { throw err(403, 'no read') }) } })
    expect(await screen.findByText('no read')).toBeInTheDocument()
  })

  it('shows the diagram notice over 2000 items', async () => {
    const many = Array.from({ length: 2001 }, (_, i) => item(`x${i}`))
    setup({ items: many, tasks: [] })
    expect(await screen.findByText('More than 2000 records match — narrow the filters to draw the diagram')).toBeInTheDocument()
    expect(rf.props).toBeNull()
  })

  it('shows each item with its name, color and progress, a leaf without task in the warning color', async () => {
    setup()
    await ready()
    const i1 = within(screen.getByTestId('node-i1'))
    expect(i1.getByText('Design')).toBeInTheDocument()
    expect(i1.getByText('3 / 4')).toBeInTheDocument()
    expect(screen.getByTestId('node-i1').querySelector('[data-testid="pbs-box"]')).toHaveStyle({ backgroundColor: '#ff0000' })
    // A leaf without a task warns instead of a bar: the theme's warning.main
    // (MUI v9 default #ed6c02).
    const i5 = within(screen.getByTestId('node-i5'))
    expect(i5.getByText('No task produces this')).toBeInTheDocument()
    expect(i5.getByText('No task produces this')).toHaveStyle({ color: 'rgb(237, 108, 2)' })
  })

  it('uses the stored counts when the task read is capped, with the caption', async () => {
    const capped = Array.from({ length: 1001 }, (_, i) => ({ id: `t${i}`, project_id: 'p1', pbs_item_id: i % 2 ? 'i2' : 'i3', closed: false }))
    const { ops } = setup({ tasks: capped })
    await ready()
    expect(ops.listPage).toHaveBeenCalledWith('project_task', { filter: { project_id: 'p1' }, order: 'wbs_number', pageSize: 200, page: 6 })
    expect(screen.getByText('First 1000 shown')).toBeInTheDocument()
    // i2 and i3 keep their stored counts (the roll-up can't be trusted past the cap).
    expect(within(screen.getByTestId('node-i2')).getByText('1 / 2')).toBeInTheDocument()
    expect(within(screen.getByTestId('node-i3')).getByText('1 / 1')).toBeInTheDocument()
  })

  it('adds an item from the toolbar with a parent, and undoes it', async () => {
    const { ops } = setup()
    fireEvent.click(await editable())
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Delivery' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Hand over' } })
    // MUI's Select opens on mousedown in jsdom, not on the synthetic click alone.
    fireEvent.mouseDown(screen.getByLabelText('Parent'))
    fireEvent.click(await screen.findByRole('option', { name: 'Design' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(ops.create).toHaveBeenCalledTimes(1))
    expect(ops.create).toHaveBeenCalledWith('project_pbs_item', expect.objectContaining({ project_id: 'p1', name: 'Delivery', description: 'Hand over', parent_id: 'i1', x: expect.any(Number), y: expect.any(Number) }))
    await waitFor(() => expect(rf.props.nodes.map((n) => n.id)).toContain('new1'))
    await act(async () => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await waitFor(() => expect(ops.remove).toHaveBeenLastCalledWith('project_pbs_item', 'new1'))
    await act(async () => fireEvent.keyDown(window, { key: 'y', ctrlKey: true }))
    await waitFor(() => expect(ops.create).toHaveBeenLastCalledWith('project_pbs_item', expect.objectContaining({ name: 'Delivery', parent_id: 'i1' })))
    // A refused create keeps the dialog open with its error.
    ops.create.mockRejectedValueOnce(err(422, 'too long'))
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await within(screen.getByRole('dialog')).findByText('too long')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  }, 20000)

  it('edits the name, description, color and parent, undoing each', async () => {
    const { ops } = setup()
    await ready()
    // Double-click opens the edit dialog, pre-filled, with a Parent select.
    fireEvent.doubleClick(screen.getByTestId('node-i2').querySelector('[data-testid="pbs-box"]')!)
    expect(screen.getByLabelText('Name')).toHaveValue('Mock-ups')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Screens' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'UI' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(ops.update).toHaveBeenLastCalledWith('project_pbs_item', 'i2', expect.objectContaining({ name: 'Screens', description: 'UI', parent_id: 'i1' })))
    await act(async () => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await waitFor(() => expect(ops.update).toHaveBeenLastCalledWith('project_pbs_item', 'i2', expect.objectContaining({ name: 'Mock-ups', description: null, parent_id: 'i1' })))

    fireEvent.click(within(screen.getByTestId('node-i3')).getByRole('button', { name: 'Color' }))
    fireEvent.change(screen.getByLabelText('Pick a color'), { target: { value: '#00ff00' } })
    // The awaited check lets the history entry be recorded before the Ctrl+Z.
    await waitFor(() => expect(ops.update).toHaveBeenLastCalledWith('project_pbs_item', 'i3', { color: '#00ff00' }))
    await act(async () => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await waitFor(() => expect(ops.update).toHaveBeenLastCalledWith('project_pbs_item', 'i3', { color: null }))
  }, 20000)

  it('re-parents by drawing a line, undoing a refused one', async () => {
    const { ops } = setup()
    await ready()
    act(() => rf.props.onConnect!({ source: 'i4', target: 'i5' }))
    await waitFor(() => expect(ops.update).toHaveBeenLastCalledWith('project_pbs_item', 'i5', { parent_id: 'i4' }))
    await waitFor(() => expect(rf.props.edges.map((e) => e.target)).toContain('i5'))
    ops.update.mockRejectedValueOnce(err(403, 'not the manager'))
    act(() => rf.props.onConnect!({ source: 'i4', target: 'i1' }))
    expect(await screen.findByText('not the manager')).toBeInTheDocument()
    expect(rf.props.edges.map((e) => e.target)).not.toContain('i1')
    // Deleting the line clears the parent.
    act(() => rf.props.onEdgesDelete!([rf.props.edges.find((e) => e.target === 'i5')!]))
    expect(ops.update).toHaveBeenLastCalledWith('project_pbs_item', 'i5', { parent_id: null })
    await waitFor(() => expect(rf.props.edges.map((e) => e.target)).not.toContain('i5'))
  })

  it('inserts a lone item dropped on a line, and undoes it', async () => {
    const { ops } = setup()
    await ready()
    // i1 (100, 50) → i2 (400, 300): i5 centered on the line between them.
    const mid = { x: (100 + 400 + PBS_BOX_SIZE.w) / 2, y: (50 + PBS_BOX_SIZE.h + 300) / 2 }
    act(() => rf.props.onNodeDragStop!(null, { ...node('i5'), position: { x: mid.x - PBS_BOX_SIZE.w / 2, y: mid.y - PBS_BOX_SIZE.h / 2 } }))
    await waitFor(() => expect(ops.update).toHaveBeenCalledWith('project_pbs_item', 'i2', { parent_id: 'i5' }))
    expect(ops.update).toHaveBeenCalledWith('project_pbs_item', 'i5', { parent_id: 'i1' })
    await act(async () => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await waitFor(() => expect(ops.update).toHaveBeenLastCalledWith('project_pbs_item', 'i5', { parent_id: null }))
    expect(ops.update).toHaveBeenCalledWith('project_pbs_item', 'i2', { parent_id: 'i1' })
  })

  it('saves moves and snaps back on a refusal', async () => {
    const { ops } = setup()
    await ready()
    await act(async () => rf.props.onNodeDragStop!(null, { ...node('i1'), position: { x: 100, y: 2000 } }))
    expect(ops.update).toHaveBeenCalledWith('project_pbs_item', 'i1', { x: 100, y: 2000 })
    expect(node('i1').position).toEqual({ x: 100, y: 2000 })
    ops.update.mockRejectedValueOnce(err(403, 'not the manager'))
    await act(async () => rf.props.onNodeDragStop!(null, { ...node('i1'), position: { x: 100, y: 4000 } }))
    expect(await screen.findByText('not the manager')).toBeInTheDocument()
    await waitFor(() => expect(node('i1').position).toEqual({ x: 100, y: 2000 }))
  })

  it('is read-only without the edit right', async () => {
    const { ops } = setup({ edit: false })
    await ready()
    expect(screen.queryByRole('button', { name: 'Add item' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Color' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Re-arrange' })).toBeNull()
    expect(rf.props.onConnect).toBeUndefined()
    expect(rf.props.nodesDraggable).toBe(false)
    expect(rf.props.edges.every((e) => e.deletable === false)).toBe(true)
    fireEvent.doubleClick(screen.getByTestId('node-i2').querySelector('[data-testid="pbs-box"]')!)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(ops.update).not.toHaveBeenCalled()
  })

  it('deletes an item from its box, undoing the delete', async () => {
    const { ops } = setup()
    await ready()
    fireEvent.click(within(screen.getByTestId('node-i3')).getByRole('button', { name: 'Delete' }))
    expect(ops.remove).toHaveBeenCalledWith('project_pbs_item', 'i3')
    await waitFor(() => expect(rf.props.nodes.map((n) => n.id)).not.toContain('i3'))
    await act(async () => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await waitFor(() => expect(ops.create).toHaveBeenLastCalledWith('project_pbs_item', expect.objectContaining({ name: 'Wiring', parent_id: 'i1' })))
    await waitFor(() => expect(rf.props.nodes.map((n) => n.id)).toContain('new1'))
  })

  it('opens the task list filtered by the project and the item from its count', async () => {
    setup()
    await ready()
    fireEvent.click(within(screen.getByTestId('node-i2')).getByTestId('pbs-count'))
    expect(nav.push).toHaveBeenCalledTimes(1)
    const url = new URL(nav.push.mock.calls[0][0], 'http://x.test')
    expect(url.pathname).toBe('/app/project/tasks')
    expect(url.searchParams.get('filter[project_id]')).toBe('p1')
    expect(url.searchParams.get('filter[pbs_item_id]')).toBe('i2')
  })

  it('uses the items own positions and lays out never-placed ones like the WBS', async () => {
    // r2 far away: its fixed spot must not push the tree layout's boxes aside.
    const rows = [item('r1'), item('k1', { parent_id: 'r1' }), item('k2', { parent_id: 'r1' }), item('r2', { x: 1000, y: 2000 })]
    const { ops } = setup({ items: rows, tasks: [] })
    await ready()
    expect(node('r2').position).toEqual({ x: 1000, y: 2000 })
    const { nodes, roots, visible } = buildWbs(rows.map((r) => ({ id: r.id, parentId: r.parent_id })), new Set())
    const want = layoutWbs(nodes, roots, visible, PBS_BOX_SIZE)
    for (const r of rows) if (!r.x && !r.y) expect(node(r.id).position).toEqual(want[r.id])
    // Re-arrange places every box again: the three never-placed ones plus r2, whose
    // saved spot yields to the tree layout.
    fireEvent.click(screen.getByRole('button', { name: 'Re-arrange' }))
    await waitFor(() => expect(ops.update).toHaveBeenCalledTimes(4))
    expect(ops.update).toHaveBeenCalledWith('project_pbs_item', 'r1', want.r1)
  })

  it('at 390px the add and edit dialogs offer the parent', async () => {
    setViewportWidth(390)
    const { ops } = setup()
    await ready()
    // Icon only on a phone, the label as its name.
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }))
    expect(screen.getByLabelText('Parent')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.doubleClick(screen.getByTestId('node-i2').querySelector('[data-testid="pbs-box"]')!)
    expect(screen.getByLabelText('Parent')).toBeInTheDocument()
    expect(ops.update).not.toHaveBeenCalled()
  })

  it('exports PNG and PDF like OBS', async () => {
    setup()
    await ready()
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Export' })) })
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Export PNG' })))
    await waitFor(() => expect(exportPng).toHaveBeenCalledWith(expect.any(HTMLElement), { x: 0, y: 0, width: 100, height: 50 }, 'PBS', expect.any(String)))
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Export' })) })
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Export PDF' })))
    await waitFor(() => expect(exportPdf).toHaveBeenCalledWith(expect.any(HTMLElement), { x: 0, y: 0, width: 100, height: 50 }, expect.objectContaining({ title: 'PBS' }), 'PBS'))
  })
})
