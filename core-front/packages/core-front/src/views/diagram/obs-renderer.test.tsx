import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentType, ReactNode } from 'react'

// React Flow stubbed as in pert-renderer.test.tsx: each node drawn through its nodeTypes component.
type RfNode = { id: string; type: string; data: unknown; position: { x: number; y: number }; width?: number; height?: number }
type RfEdge = { id: string; source: string; target: string; type?: string; markerEnd?: unknown; deletable?: boolean }
type RfProps = {
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

import { ObsRenderer, OBS_BOX_SIZE } from './obs-renderer'
import { layoutWbs } from './auto-layout'
import { buildWbs } from './wbs'
import { registerKanbanColumnsGuard } from '../kanban-columns'
import { RelationOpsProvider, type RelationOps } from '../relation-ops'
import { ApiError } from '../../api/errors'

type Row = { id: string; project_id: string; parent_id: string | null; kind: string; contact_id: string | null; user_id: string | null; title: string; text: string; color: string | null; x: number; y: number }
const box = (id: string, over: Partial<Row> = {}): Row => ({ id, project_id: 'p1', parent_id: null, kind: 'text', contact_id: null, user_id: null, title: id, text: '', color: null, x: 0, y: 0, ...over })
const boxes = (): Row[] => [
  box('b1', { kind: 'contact', contact_id: 'c1', title: 'CEO', color: '#ff0000', x: 100, y: 50 }),
  box('b2', { kind: 'user', user_id: 'u1', title: 'CTO', parent_id: 'b1', x: 400, y: 300 }),
  box('b3', { kind: 'text', title: 'Board', text: 'Meets monthly', parent_id: 'b1', x: 700, y: 300 }),
  box('b4', { kind: 'contact', contact_id: 'gone', title: 'Old', x: 1000, y: 50 }),
  box('b5', { kind: 'user', user_id: 'nouser', title: 'Ghost', x: 1300, y: 50 }),
  box('b6', { kind: 'contact', contact_id: 'c1', title: 'Advisor', x: 1600, y: 50 }),
]
const config = { entity: 'project_obs_box', projectField: 'project_id', projectEntity: 'project', companyField: 'company_id', canEdit: 'test.obs' }
const err = (status: number, message: string) => new ApiError({ code: status === 422 ? 'VALIDATION_ERROR' : 'FORBIDDEN', message, status })

function setup(opts: { rows?: Row[]; edit?: boolean; company?: string | null; ops?: Partial<RelationOps> } = {}) {
  const { edit = true, company = 'co1' } = opts
  let rows = opts.rows ?? boxes()
  let created = 0
  registerKanbanColumnsGuard('test.obs', async () => edit)
  const records: Record<string, Record<string, unknown>> = {
    'contact:c1': { id: 'c1', name: 'Alice', email: 'alice@x.io' },
    'users:u1': { id: 'u1', display_name: 'Bob', email: 'bob@x.io' },
    'project:p1': { id: 'p1', company_id: company },
  }
  const ops = {
    list: vi.fn(async () => []),
    get: vi.fn(async (e: string, id: string) => {
      const r = records[`${e}:${id}`]
      if (!r) throw err(404, 'not found')
      return r
    }),
    create: vi.fn(async (_e: string, body: Record<string, unknown>) => ({ id: `new${++created}`, ...body })),
    update: vi.fn(async (_e: string, id: string, body: Record<string, unknown>) => ({ ...rows.find((r) => r.id === id)!, ...body })),
    remove: vi.fn(async (_e: string, id: string) => {
      rows = rows.filter((r) => r.id !== id).map((r) => (r.parent_id === id ? { ...r, parent_id: null } : r))
    }),
    listPage: vi.fn(async (e: string, o: { page?: number; pageSize?: number } = {}) => {
      if (e === 'project_obs_box') {
        const size = o.pageSize ?? 200
        const page = rows.slice(((o.page ?? 1) - 1) * size, (o.page ?? 1) * size)
        return { records: page, total: rows.length }
      }
      if (e === 'contact_company') return { records: [{ id: 'cc1', contact_id: 'c1', company_id: 'co1' }], total: 1 }
      if (e === 'contact') return { records: [{ id: 'c1', name: 'Alice', email: 'alice@x.io' }], total: 1 }
      if (e === 'users') return { records: [{ id: 'u2', display_name: 'Zed', email: 'zed@x.io' }], total: 1 }
      return { records: [], total: 0 }
    }),
    ...opts.ops,
  } as unknown as RelationOps & { update: ReturnType<typeof vi.fn>; listPage: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }
  render(
    <RelationOpsProvider ops={ops}>
      <ObsRenderer config={config} projectId="p1" />
    </RelationOpsProvider>,
  )
  return { ops }
}
const node = (id: string) => rf.props.nodes.find((n) => n.id === id)!
const ready = () => waitFor(() => expect(rf.props?.nodes.length).toBeGreaterThan(0))
const editable = () => screen.findByRole('button', { name: 'Add contact' })

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  rf.props = null as unknown as RfProps
  rf.zoom = 1
})

describe('ObsRenderer', () => {
  it('loads every box page by page and shows a refused read', async () => {
    const many = Array.from({ length: 201 }, (_, i) => box(`x${i}`))
    const { ops } = setup({ rows: many })
    await waitFor(() => expect(rf.props?.nodes).toHaveLength(201))
    expect(ops.listPage).toHaveBeenCalledWith('project_obs_box', { filter: { project_id: 'p1' }, order: 'created_at', pageSize: 200, page: 1 })
    expect(ops.listPage).toHaveBeenCalledWith('project_obs_box', { filter: { project_id: 'p1' }, order: 'created_at', pageSize: 200, page: 2 })
    cleanup()
    setup({ ops: { listPage: vi.fn(async () => { throw err(403, 'no read') }) } })
    expect(await screen.findByText('no read')).toBeInTheDocument()
  })

  it('inserts a lone box dropped on a line, and undoes it', async () => {
    const { ops } = setup()
    await editable()
    // b1 (100, 50) → b2 (400, 300): b6 centered on the line between them.
    const mid = { x: (100 + 400 + OBS_BOX_SIZE.w) / 2, y: (50 + OBS_BOX_SIZE.h + 300) / 2 }
    act(() => rf.props.onNodeDragStop!(null, { ...node('b6'), position: { x: mid.x - OBS_BOX_SIZE.w / 2, y: mid.y - OBS_BOX_SIZE.h / 2 } }))
    await waitFor(() => expect(ops.update).toHaveBeenCalledWith('project_obs_box', 'b2', { parent_id: 'b6' }))
    expect(ops.update).toHaveBeenCalledWith('project_obs_box', 'b6', { parent_id: 'b1' })
    await act(async () => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await waitFor(() => expect(ops.update).toHaveBeenLastCalledWith('project_obs_box', 'b6', { parent_id: null }))
    expect(ops.update).toHaveBeenCalledWith('project_obs_box', 'b2', { parent_id: 'b1' })
  })

  it('undoes a color change and a parent link', async () => {
    const { ops } = setup()
    await editable()
    await act(async () => (node('b1').data as { onColor: (c: string) => void }).onColor('#00ff00'))
    await waitFor(() => expect(ops.update).toHaveBeenLastCalledWith('project_obs_box', 'b1', { color: '#00ff00' }))
    act(() => rf.props.onConnect!({ source: 'b4', target: 'b5' }))
    await waitFor(() => expect(ops.update).toHaveBeenLastCalledWith('project_obs_box', 'b5', { parent_id: 'b4' }))
    await act(async () => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await waitFor(() => expect(ops.update).toHaveBeenLastCalledWith('project_obs_box', 'b5', { parent_id: null }))
    await act(async () => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await waitFor(() => expect(ops.update).toHaveBeenLastCalledWith('project_obs_box', 'b1', { color: '#ff0000' }))
  })

  it('undoes a delete by re-creating the box under its old id', async () => {
    const { ops } = setup()
    await editable()
    // A color change before the delete: undone later, it must reach the re-created box.
    await act(async () => (node('b1').data as { onColor: (c: string) => void }).onColor('#00ff00'))
    await act(async () => (node('b1').data as { onDelete: () => void }).onDelete())
    await waitFor(() => expect(ops.remove).toHaveBeenLastCalledWith('project_obs_box', 'b1'))
    await act(async () => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await waitFor(() => expect(ops.update).toHaveBeenCalledWith('project_obs_box', 'b3', { parent_id: 'new1' }))
    expect(ops.create).toHaveBeenLastCalledWith('project_obs_box', expect.objectContaining({ kind: 'contact', contact_id: 'c1', title: 'CEO', color: '#00ff00', x: 100, y: 50, parent_id: null }))
    expect(ops.update).toHaveBeenCalledWith('project_obs_box', 'b2', { parent_id: 'new1' })
    await act(async () => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await waitFor(() => expect(ops.update).toHaveBeenLastCalledWith('project_obs_box', 'new1', { color: '#ff0000' }))
    // Redo twice: the color again, then the delete — of the new id.
    await act(async () => fireEvent.keyDown(window, { key: 'y', ctrlKey: true }))
    await waitFor(() => expect(ops.update).toHaveBeenLastCalledWith('project_obs_box', 'new1', { color: '#00ff00' }))
    await act(async () => fireEvent.keyDown(window, { key: 'y', ctrlKey: true }))
    await waitFor(() => expect(ops.remove).toHaveBeenLastCalledWith('project_obs_box', 'new1'))
  })

  it('undoes and redoes a create', async () => {
    const { ops } = setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Add text' }))
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'Committee' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(ops.create).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await act(async () => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await waitFor(() => expect(ops.remove).toHaveBeenLastCalledWith('project_obs_box', 'new1'))
    await act(async () => fireEvent.keyDown(window, { key: 'y', ctrlKey: true }))
    await waitFor(() => expect(ops.create).toHaveBeenLastCalledWith('project_obs_box', expect.objectContaining({ kind: 'text', title: 'Committee' })))
    await act(async () => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    await waitFor(() => expect(ops.remove).toHaveBeenLastCalledWith('project_obs_box', 'new2'))
  })

  it('shows a refused undo of a delete', async () => {
    const { ops } = setup()
    await editable()
    await act(async () => (node('b4').data as { onDelete: () => void }).onDelete())
    await waitFor(() => expect(ops.remove).toHaveBeenCalled())
    ops.create.mockRejectedValueOnce(err(422, 'contact gone'))
    await act(async () => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    expect(await screen.findByText('contact gone')).toBeInTheDocument()
  })

  it('shows each box with its color, title and kind label', async () => {
    const { ops } = setup()
    expect(await within(await screen.findByTestId('node-b1')).findByText('Alice')).toBeInTheDocument()
    const b1 = within(screen.getByTestId('node-b1'))
    expect(b1.getByText('CEO')).toBeInTheDocument()
    expect(b1.getByText('alice@x.io')).toBeInTheDocument()
    expect(screen.getByTestId('node-b1').querySelector('[data-testid="obs-box"]')).toHaveStyle({ backgroundColor: '#ff0000' })
    expect(await within(screen.getByTestId('node-b2')).findByText('Bob')).toBeInTheDocument()
    expect(within(screen.getByTestId('node-b3')).getByText('Meets monthly')).toBeInTheDocument()
    expect(await within(screen.getByTestId('node-b4')).findByText('Deleted contact')).toBeInTheDocument()
    expect(await within(screen.getByTestId('node-b5')).findByText('Unknown user')).toBeInTheDocument()
    expect(await within(screen.getByTestId('node-b6')).findByText('Alice')).toBeInTheDocument()
    // b1 and b6 share contact c1: one read.
    expect(ops.get.mock.calls.filter(([e, id]) => e === 'contact' && id === 'c1')).toHaveLength(1)
  })

  it('zoomed out, an untitled box shows its first content line', async () => {
    rf.zoom = 0.1
    setup({ rows: [box('b1', { kind: 'contact', contact_id: 'c1', title: '' }), box('b2', { title: '', text: 'Free text' })] })
    expect(await within(await screen.findByTestId('node-b1')).findByText('Alice')).toBeInTheDocument()
    expect(within(screen.getByTestId('node-b2')).getByText('Free text')).toBeInTheDocument()
  })

  it('draws parent lines and edits them with the edit right', async () => {
    const { ops } = setup()
    await editable()
    expect(rf.props.edges.map((e) => [e.source, e.target, e.type, e.markerEnd])).toEqual([
      ['b1', 'b2', 'smoothstep', undefined],
      ['b1', 'b3', 'smoothstep', undefined],
    ])
    ops.update.mockRejectedValueOnce(err(422, 'cycle'))
    act(() => rf.props.onConnect!({ source: 'b4', target: 'b5' }))
    expect(await screen.findByText('cycle')).toBeInTheDocument()
    expect(rf.props.edges).toHaveLength(2)
    act(() => rf.props.onConnect!({ source: 'b4', target: 'b5' }))
    expect(ops.update).toHaveBeenLastCalledWith('project_obs_box', 'b5', { parent_id: 'b4' })
    await waitFor(() => expect(rf.props.edges.map((e) => e.target)).toContain('b5'))
    act(() => rf.props.onEdgesDelete!([rf.props.edges.find((e) => e.target === 'b2')!]))
    expect(ops.update).toHaveBeenLastCalledWith('project_obs_box', 'b2', { parent_id: null })
    await waitFor(() => expect(rf.props.edges.map((e) => e.target)).not.toContain('b2'))
  })

  it('adds contact, user and text boxes from the toolbar', async () => {
    const { ops } = setup()
    fireEvent.click(await editable())
    const pick = async (label: string, q: string, option: RegExp) => {
      const input = screen.getByRole('combobox', { name: label })
      fireEvent.change(input, { target: { value: q } })
      fireEvent.click(await screen.findByRole('option', { name: option }))
    }
    await pick('Contact', 'Al', /Alice/)
    expect(ops.get).toHaveBeenCalledWith('project', 'p1')
    expect(ops.listPage).toHaveBeenCalledWith('contact_company', expect.objectContaining({ filter: { company_id: 'co1' } }))
    expect(ops.listPage).toHaveBeenCalledWith('contact', expect.objectContaining({ in: { id: ['c1'] } }))
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'CFO' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(ops.create).toHaveBeenCalledWith('project_obs_box', expect.objectContaining({ project_id: 'p1', kind: 'contact', contact_id: 'c1', title: 'CFO', x: expect.any(Number), y: expect.any(Number) })))
    await waitFor(() => expect(rf.props.nodes.map((n) => n.id)).toContain('new1'))

    fireEvent.click(screen.getByRole('button', { name: 'Add user' }))
    await pick('User', 'ze', /Zed/)
    expect(ops.listPage).toHaveBeenCalledWith('users', expect.objectContaining({ search: { email: 'ze' } }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(ops.create).toHaveBeenLastCalledWith('project_obs_box', expect.objectContaining({ kind: 'user', user_id: 'u2' })))

    fireEvent.click(screen.getByRole('button', { name: 'Add text' }))
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'Committee' } })
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Line 1\nLine 2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(ops.create).toHaveBeenLastCalledWith('project_obs_box', expect.objectContaining({ kind: 'text', title: 'Committee', text: 'Line 1\nLine 2' })))

    // A refused create keeps the dialog open with its error.
    ops.create.mockRejectedValueOnce(err(422, 'too long'))
    fireEvent.click(screen.getByRole('button', { name: 'Add text' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await within(screen.getByRole('dialog')).findByText('too long')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  }, 20000)

  it('offers any person when the project has no company', async () => {
    const { ops } = setup({ company: null })
    fireEvent.click(await editable())
    fireEvent.change(screen.getByRole('combobox', { name: 'Contact' }), { target: { value: 'Al' } })
    expect(await screen.findByRole('option', { name: /Alice/ })).toBeInTheDocument()
    expect(ops.listPage).toHaveBeenCalledWith('contact', expect.objectContaining({ filter: { kind: 'contact' }, search: { name: 'Al' } }))
  })

  it('edits color, deletes and edits a box from its buttons', async () => {
    const { ops } = setup()
    await editable()
    const b3 = within(screen.getByTestId('node-b3'))
    fireEvent.click(b3.getByRole('button', { name: 'Color' }))
    fireEvent.change(screen.getByLabelText('Pick a color'), { target: { value: '#00ff00' } })
    expect(ops.update).toHaveBeenLastCalledWith('project_obs_box', 'b3', { color: '#00ff00' })
    await waitFor(() => expect(screen.getByTestId('node-b3').querySelector('[data-testid="obs-box"]')).toHaveStyle({ backgroundColor: '#00ff00' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear color' }))
    expect(ops.update).toHaveBeenLastCalledWith('project_obs_box', 'b3', { color: null })

    fireEvent.doubleClick(screen.getByTestId('node-b3').querySelector('[data-testid="obs-box"]')!)
    expect(screen.getByLabelText('Role')).toHaveValue('Board')
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Weekly' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(ops.update).toHaveBeenLastCalledWith('project_obs_box', 'b3', { title: 'Board', text: 'Weekly' }))
    expect(await within(screen.getByTestId('node-b3')).findByText('Weekly')).toBeInTheDocument()

    fireEvent.click(within(screen.getByTestId('node-b1')).getByRole('button', { name: 'Delete' }))
    expect(ops.remove).toHaveBeenCalledWith('project_obs_box', 'b1')
    await waitFor(() => expect(rf.props.nodes.map((n) => n.id)).not.toContain('b1'))
    expect(rf.props.edges).toEqual([])
  })

  it('sends one color write per pick, showing the picked color meanwhile', async () => {
    const { ops } = setup()
    await editable()
    fireEvent.click(within(screen.getByTestId('node-b3')).getByRole('button', { name: 'Color' }))
    const input = screen.getByLabelText('Pick a color') as HTMLInputElement
    for (const c of ['#111111', '#222222', '#333333']) fireEvent.input(input, { target: { value: c } })
    expect(ops.update).not.toHaveBeenCalled()
    const shown = () => screen.getByTestId('node-b3').querySelector('[data-testid="obs-box"]')
    expect(shown()).toHaveStyle({ backgroundColor: '#333333' })
    fireEvent.change(input, { target: { value: '#333333' } })
    expect(ops.update).toHaveBeenCalledTimes(1)
    expect(ops.update).toHaveBeenCalledWith('project_obs_box', 'b3', { color: '#333333' })
    // A refused pick goes back to the stored color.
    ops.update.mockRejectedValueOnce(err(403, 'no color'))
    fireEvent.change(input, { target: { value: '#444444' } })
    expect(await screen.findByText('no color')).toBeInTheDocument()
    await waitFor(() => expect(shown()).toHaveStyle({ backgroundColor: '#333333' }))
  })

  it('keeps a later drop when an earlier one of the same box is refused', async () => {
    const { ops } = setup()
    await editable()
    let refuse!: (e: unknown) => void
    ops.update.mockImplementationOnce(() => new Promise((_, reject) => { refuse = reject }))
    await act(async () => { rf.props.onNodeDragStop!(null, { ...node('b1'), position: { x: 100, y: 2000 } }) })
    await act(async () => rf.props.onNodeDragStop!(null, { ...node('b1'), position: { x: 100, y: 4000 } }))
    expect(node('b1').position).toEqual({ x: 100, y: 4000 })
    await act(async () => refuse(err(403, 'late refusal')))
    expect(await screen.findByText('late refusal')).toBeInTheDocument()
    expect(node('b1').position).toEqual({ x: 100, y: 4000 })
  })

  it('saves moves and snaps back on a refusal', async () => {
    const { ops } = setup()
    await editable()
    await act(async () => rf.props.onNodeDragStop!(null, { ...node('b1'), position: { x: 100, y: 2000 } }))
    expect(ops.update).toHaveBeenCalledWith('project_obs_box', 'b1', { x: 100, y: 2000 })
    expect(node('b1').position).toEqual({ x: 100, y: 2000 })
    ops.update.mockRejectedValueOnce(err(403, 'not the manager'))
    await act(async () => rf.props.onNodeDragStop!(null, { ...node('b1'), position: { x: 100, y: 4000 } }))
    expect(await screen.findByText('not the manager')).toBeInTheDocument()
    await waitFor(() => expect(node('b1').position).toEqual({ x: 100, y: 2000 }))
  })

  it('is read-only without the edit right', async () => {
    const { ops } = setup({ edit: false })
    await ready()
    await screen.findAllByText('Alice')
    expect(screen.queryByRole('button', { name: 'Add contact' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Color' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Re-arrange' })).toBeNull()
    expect(rf.props.onConnect).toBeUndefined()
    expect(rf.props.nodesDraggable).toBe(false)
    expect(rf.props.edges.every((e) => e.deletable === false)).toBe(true)
    fireEvent.doubleClick(screen.getByTestId('node-b3').querySelector('[data-testid="obs-box"]')!)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(ops.update).not.toHaveBeenCalled()
  })

  it('creates a new contact from the picker as a person of the project company', async () => {
    const { ops } = setup()
    fireEvent.click(await editable())
    fireEvent.change(screen.getByRole('combobox', { name: 'Contact' }), { target: { value: 'Carol' } })
    fireEvent.click(await screen.findByRole('option', { name: 'Create a new contact' }))
    const wizard = (await screen.findAllByRole('dialog')).at(-1)!
    expect(within(wizard).getByDisplayValue('Carol')).toBeInTheDocument()
    fireEvent.click(within(wizard).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(ops.create).toHaveBeenCalledWith('contact', expect.objectContaining({ kind: 'contact', name: 'Carol' })))
    await waitFor(() => expect(ops.create).toHaveBeenCalledWith('contact_company', { contact_id: 'new1', company_id: 'co1' }))
    expect(screen.getByRole('combobox', { name: 'Contact' })).toHaveValue('Carol')
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(ops.create).toHaveBeenLastCalledWith('project_obs_box', expect.objectContaining({ kind: 'contact', contact_id: 'new1' })))
  })

  it('places unsaved boxes with the tree layout and re-arranges all', async () => {
    const rows = [box('r1'), box('k1', { parent_id: 'r1' }), box('k2', { parent_id: 'r1' }), box('r2')]
    const { ops } = setup({ rows })
    await editable()
    const { nodes, roots, visible } = buildWbs(rows.map((r) => ({ id: r.id, parentId: r.parent_id })), new Set())
    const want = layoutWbs(nodes, roots, visible, OBS_BOX_SIZE)
    for (const r of rows) expect(node(r.id).position).toEqual(want[r.id])
    fireEvent.click(screen.getByRole('button', { name: 'Re-arrange' }))
    await waitFor(() => expect(ops.update).toHaveBeenCalledTimes(4))
    expect(ops.update).toHaveBeenCalledWith('project_obs_box', 'r2', want.r2)
  })
})
