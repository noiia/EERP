import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import type { Node, NodeProps } from '@xyflow/react'

// React Flow needs real layout (ResizeObserver, sizes) jsdom lacks: like the shell's
// WorkflowMap tests, the stub keeps its props so the tests call the canvas's handlers
// the way React Flow would.
type RfNode = { id: string; position: { x: number; y: number }; measured?: { width: number; height: number } }
type RfEdge = { id: string; source: string; target: string; selected?: boolean }
type RfProps = {
  nodes: RfNode[]
  edges: RfEdge[]
  onEdgesChange?: (c: unknown[]) => void
  onEdgesDelete?: (e: RfEdge[]) => void
  onNodesChange?: (c: unknown[]) => void
  onNodeDragStop?: (e: unknown, n: RfNode) => void
  onInit?: (i: { fitView: () => void }) => void
  children?: ReactNode
}
const rf = vi.hoisted(() => ({ props: null as unknown as RfProps }))
vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: RfProps) => {
    rf.props = props
    return (
      // React Flow's Delete key removes only the edges it was handed as selected.
      <div data-testid="react-flow" tabIndex={0} onKeyDown={(e) => {
        if (e.key === 'Delete') props.onEdgesDelete?.(props.edges.filter((x) => x.selected))
      }}>
        <div className="react-flow__viewport" />
        {props.children}
      </div>
    )
  },
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  getNodesBounds: () => ({ x: 0, y: 0, width: 100, height: 50 }),
}))
const exportPng = vi.hoisted(() => vi.fn(async () => {}))
const exportPdf = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('./export', () => ({ exportPng, exportPdf }))

import { DIAGRAM_RECORD_CAP, DiagramCanvas, DiagramCapNotice, useDiagramRecords, type DiagramCanvasProps } from './diagram-canvas'
import { TaskBox, type TaskBoxData } from './task-box'
import { RelationOpsProvider, type RelationOps, type ViewLayout } from '../relation-ops'
import type { EntityListOptions } from '../../api/list-options'

type ListPage = NonNullable<RelationOps['listPage']>
const at = (x: number, y: number) => ({ x, y })
const node = (id: string): Node => ({ id, position: at(0, 0), data: {} })
const pos = (id: string) => rf.props.nodes.find((n) => n.id === id)!.position
const flush = () => act(() => vi.advanceTimersByTimeAsync(0))

function setup(over: Partial<DiagramCanvasProps> = {}, layout: ViewLayout = { positions: {}, folded: [] }) {
  const saveViewLayout = vi.fn(async () => {})
  const getViewLayout = vi.fn(async () => layout)
  const ops = { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn(), getViewLayout, saveViewLayout }
  const props: DiagramCanvasProps = {
    entity: 'project_task',
    mode: 'wbs',
    title: 'Plan',
    nodes: [node('a'), node('b')],
    edges: [],
    autoLayout: () => ({ a: at(0, 0), b: at(500, 500) }),
    legend: [{ color: '#ff0000', label: 'Critical' }],
    ...over,
  }
  render(
    <RelationOpsProvider ops={ops}>
      <DiagramCanvas {...props} />
    </RelationOpsProvider>,
  )
  return { saveViewLayout, getViewLayout }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('DiagramCanvas', () => {
  it('merges saved positions with auto layout', async () => {
    const { saveViewLayout, getViewLayout } = setup({}, { positions: { b: at(0, 0), stale: at(9, 9) }, folded: [] })
    await flush()
    expect(getViewLayout).toHaveBeenCalledWith('project_task', 'wbs')
    expect(pos('b')).toEqual(at(0, 0))
    // a's auto spot is under saved b: it moves to a free spot.
    expect(pos('a')).not.toEqual(at(0, 0))
    act(() => rf.props.onNodeDragStop!(null, { id: 'b', position: at(0, 0) }))
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(saveViewLayout).toHaveBeenCalledTimes(1)
    const [, , saved] = saveViewLayout.mock.calls[0] as unknown as [string, string, ViewLayout]
    expect(Object.keys(saved.positions).sort()).toEqual(['a', 'b'])
  })

  it('saves debounced after a drag', async () => {
    const { saveViewLayout } = setup()
    await flush()
    act(() => rf.props.onNodesChange!([{ type: 'position', id: 'a', position: at(40, 40) }, { type: 'dimensions', id: 'a', dimensions: { width: 100, height: 40 } }]))
    expect(pos('a')).toEqual(at(40, 40))
    act(() => rf.props.onNodeDragStop!(null, { id: 'a', position: at(40, 40) }))
    await act(() => vi.advanceTimersByTimeAsync(200))
    act(() => rf.props.onNodeDragStop!(null, { id: 'b', position: at(800, 800) }))
    await act(() => vi.advanceTimersByTimeAsync(499))
    expect(saveViewLayout).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(saveViewLayout).toHaveBeenCalledTimes(1)
    expect(saveViewLayout).toHaveBeenCalledWith('project_task', 'wbs', { positions: { a: at(40, 40), b: at(800, 800) }, folded: [] })
  })

  it('reports the box a dragged one was dropped on', async () => {
    const onNodeDrop = vi.fn()
    setup({ onNodeDrop })
    await flush()
    act(() => rf.props.onNodeDragStop!(null, { id: 'a', position: at(510, 510) }))
    expect(onNodeDrop).toHaveBeenCalledWith('a', 'b')
    act(() => rf.props.onNodeDragStop!(null, { id: 'a', position: at(2000, 2000) }))
    expect(onNodeDrop).toHaveBeenLastCalledWith('a', null)
  })

  it('deletes the selected edge', async () => {
    const onEdgesDelete = vi.fn()
    const edges = [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'b', target: 'a' }]
    setup({ edges, onEdgesDelete })
    await flush()
    act(() => rf.props.onEdgesChange!([{ type: 'select', id: 'e1', selected: true }, { type: 'remove', id: 'e2' }]))
    fireEvent.keyDown(screen.getByTestId('react-flow'), { key: 'Delete' })
    expect(onEdgesDelete).toHaveBeenCalledWith([{ id: 'e1', source: 'a', target: 'b', selected: true }])
    act(() => rf.props.onEdgesChange!([{ type: 'select', id: 'e1', selected: false }]))
    expect(rf.props.edges.some((e) => e.selected)).toBe(false)
  })

  it('keeps saved folds the parent does not manage', async () => {
    const { saveViewLayout } = setup({}, { positions: {}, folded: ['a'] })
    await flush()
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(saveViewLayout).not.toHaveBeenCalled()
    act(() => rf.props.onNodeDragStop!(null, { id: 'a', position: at(0, 0) }))
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(saveViewLayout).toHaveBeenCalledWith('project_task', 'wbs', expect.objectContaining({ folded: ['a'] }))
  })

  it('flushes a pending save on unmount and reloads on another entity', async () => {
    const saveViewLayout = vi.fn(async () => {})
    const getViewLayout = vi.fn(async () => ({ positions: {}, folded: [] }))
    const ops = { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn(), getViewLayout, saveViewLayout }
    const ui = (entity: string) => (
      <RelationOpsProvider ops={ops}>
        <DiagramCanvas entity={entity} mode="pert" title="T" nodes={[node('a')]} edges={[]} autoLayout={() => ({ a: at(0, 0) })} legend={[]} />
      </RelationOpsProvider>
    )
    const { rerender, unmount } = render(ui('one'))
    await flush()
    act(() => rf.props.onNodeDragStop!(null, { id: 'a', position: at(50, 0) }))
    rerender(ui('two'))
    expect(saveViewLayout).toHaveBeenCalledWith('one', 'pert', { positions: { a: at(50, 0) }, folded: [] })
    await flush()
    expect(getViewLayout).toHaveBeenLastCalledWith('two', 'pert')
    expect(pos('a')).toEqual(at(0, 0))
    unmount()
    expect(saveViewLayout).toHaveBeenCalledTimes(1)
  })

  it('re-arrange resets positions and saves', async () => {
    const { saveViewLayout } = setup({}, { positions: { a: at(300, 0) }, folded: [] })
    await flush()
    expect(pos('a')).toEqual(at(300, 0))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Re-arrange' })))
    expect(pos('a')).toEqual(at(0, 0))
    expect(saveViewLayout).toHaveBeenCalledWith('project_task', 'wbs', { positions: { a: at(0, 0), b: at(500, 500) }, folded: [] })
  })

  it('restores the saved folds and saves fold changes', async () => {
    const saveViewLayout = vi.fn(async () => {})
    const ops = { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn(), getViewLayout: async () => ({ positions: {}, folded: ['a'] }), saveViewLayout }
    function Wrapper() {
      const [folded, setFolded] = useState<string[]>([])
      return (
        <RelationOpsProvider ops={ops}>
          <span data-testid="folded">{folded.join(',')}</span>
          <button onClick={() => setFolded([])}>unfold</button>
          <DiagramCanvas entity="e" mode="wbs" title="T" nodes={[node('a')]} edges={[]} autoLayout={() => ({ a: at(0, 0) })} legend={[]} folded={folded} onFoldedChange={setFolded} />
        </RelationOpsProvider>
      )
    }
    render(<Wrapper />)
    await flush()
    expect(screen.getByTestId('folded').textContent).toBe('a')
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(saveViewLayout).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('unfold'))
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(saveViewLayout).toHaveBeenCalledWith('e', 'wbs', { positions: { a: at(0, 0) }, folded: [] })
  })

  it('shows a save failure', async () => {
    const saveViewLayout = vi.fn(async () => {
      throw new Error('nope')
    })
    const ops = { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn(), saveViewLayout }
    render(
      <RelationOpsProvider ops={ops}>
        <DiagramCanvas entity="e" mode="pert" title="T" nodes={[node('a')]} edges={[]} autoLayout={() => ({ a: at(0, 0) })} legend={[]} />
      </RelationOpsProvider>,
    )
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Re-arrange' })))
    expect(screen.getByText('nope')).toBeInTheDocument()
  })

  it('works without layout ops', () => {
    render(<DiagramCanvas entity="e" mode="pert" title="T" nodes={[node('a')]} edges={[]} autoLayout={() => ({ a: at(5, 5) })} legend={[]} toolbarExtra={<span>extra</span>} />)
    expect(pos('a')).toEqual(at(5, 5))
    expect(screen.getByText('extra')).toBeInTheDocument()
    act(() => rf.props.onNodeDragStop!(null, { id: 'a', position: at(7, 7) }))
    expect(pos('a')).toEqual(at(7, 7))
  })

  it('exports, fits the view and shows the legend', async () => {
    setup()
    await flush()
    expect(screen.getByText('Critical')).toBeInTheDocument()
    const fitView = vi.fn()
    act(() => rf.props.onInit!({ fitView }))
    fireEvent.click(screen.getByRole('button', { name: 'Fit view' }))
    expect(fitView).toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Export PNG' })))
    expect(exportPng).toHaveBeenCalledWith(expect.any(HTMLElement), { x: 0, y: 0, width: 100, height: 50 }, 'Plan')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Export PDF' })))
    expect(exportPdf).toHaveBeenCalledWith(expect.any(HTMLElement), { x: 0, y: 0, width: 100, height: 50 }, { title: 'Plan', date: expect.any(Date), legend: [{ color: '#ff0000', label: 'Critical' }] }, 'Plan')
  })
})

describe('useDiagramRecords', () => {
  beforeEach(() => vi.useRealTimers())

  function Harness({ initial = [] as { id: string }[], options = {} as EntityListOptions | undefined }) {
    const r = useDiagramRecords('task', options, initial)
    if (r.capped) return <DiagramCapNotice />
    return (
      <div>
        <span data-testid="count">{r.records.length}</span>
        <span data-testid="loading">{String(r.loading)}</span>
        {r.error ? <span>{r.error}</span> : null}
        <button onClick={r.reload}>reload</button>
        <DiagramCanvas entity="task" mode="pert" title="T" nodes={[]} edges={[]} autoLayout={() => ({})} legend={[]} />
      </div>
    )
  }
  const withOps = (listPage: ListPage, ui: ReactNode) => (
    <RelationOpsProvider ops={{ list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn(), listPage }}>{ui}</RelationOpsProvider>
  )
  const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: String(from + i) }))

  it('shows the cap notice above 2000', async () => {
    const listPage = vi.fn<ListPage>(async (_e, o) => ({ records: rows(o?.pageSize ?? 0), total: 0 }))
    render(withOps(listPage, <Harness />))
    expect(await screen.findByText(/narrow the filters/)).toBeInTheDocument()
    expect(screen.getByText(new RegExp(String(DIAGRAM_RECORD_CAP)))).toBeInTheDocument()
    expect(screen.queryByTestId('react-flow')).toBeNull()
    expect(listPage).toHaveBeenLastCalledWith('task', expect.objectContaining({ page: DIAGRAM_RECORD_CAP + 1, pageSize: 1 }))
    expect(listPage).toHaveBeenCalledWith('task', expect.objectContaining({ page: 1, pageSize: 200, order: 'id' }))
  })

  it('stops at a short page, and exactly the cap is not capped', async () => {
    let probe = false
    const listPage = vi.fn<ListPage>(async (_e, o) => {
      if (o?.pageSize === 1) probe = true
      return { records: o?.pageSize === 1 ? [] : rows(200), total: 0 }
    })
    render(withOps(listPage, <Harness />))
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe(String(DIAGRAM_RECORD_CAP)))
    expect(probe).toBe(true)
    expect(screen.getByTestId('react-flow')).toBeInTheDocument()
  })

  it('reloads, reports errors and falls back to the initial data', async () => {
    const listPage = vi.fn<ListPage>().mockResolvedValueOnce({ records: rows(3), total: 3 }).mockRejectedValueOnce(new Error('down'))
    render(withOps(listPage, <Harness />))
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('3'))
    fireEvent.click(screen.getByText('reload'))
    expect(await screen.findByText('down')).toBeInTheDocument()
    cleanup()
    render(<Harness initial={rows(2)} options={undefined} />)
    expect(screen.getByTestId('count').textContent).toBe('2')
    expect(screen.getByTestId('loading').textContent).toBe('false')
  })
})

describe('TaskBox', () => {
  beforeEach(() => vi.useRealTimers())
  const fields = [{ name: 'name', label: 'Name', type: 'text' as const }, { name: 'missing', label: 'Missing', type: 'text' as const }]
  function box(data: Partial<TaskBoxData>) {
    const full: TaskBoxData = { record: { id: '1', name: 'Old' }, editable: true, fields, onCommit: vi.fn(async () => {}), onOpen: vi.fn(), ...data }
    render(<TaskBox {...({ id: '1', data: full } as unknown as NodeProps<Node<TaskBoxData>>)} />)
    return full
  }

  it('TaskBox reverts on a rejected commit', async () => {
    const data = box({ onCommit: vi.fn(async () => { throw new Error('refused') }) })
    expect(screen.queryByLabelText('Missing')).toBeNull()
    const input = screen.getByLabelText('Name')
    fireEvent.change(input, { target: { value: 'New' } })
    fireEvent.blur(input)
    expect(data.onCommit).toHaveBeenCalledWith('name', 'New')
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Old'))
    expect(screen.getByText('refused')).toBeInTheDocument()
  })

  it('has a fixed size', () => {
    box({})
    const paper = screen.getByLabelText('Name').closest('.MuiPaper-root')!
    expect(getComputedStyle(paper).width).toBe('240px')
    expect(getComputedStyle(paper).height).toBe('300px')
    expect(getComputedStyle(paper).overflow).toBe('auto')
  })

  it('commits an edit once, and not on Enter in a multiline field', () => {
    const data = box({ fields: [...fields, { name: 'notes', label: 'Notes', type: 'text', widget: 'long' }], record: { id: '1', name: 'Old', notes: '' } })
    const input = screen.getByLabelText('Name')
    fireEvent.change(input, { target: { value: 'New' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(data.onCommit).toHaveBeenCalledTimes(1)
    const notes = screen.getByLabelText('Notes')
    fireEvent.change(notes, { target: { value: 'line' } })
    fireEvent.keyDown(notes, { key: 'Enter' })
    expect(data.onCommit).toHaveBeenCalledTimes(1)
  })

  it('commits on enter, not when unchanged', async () => {
    const data = box({})
    const input = screen.getByLabelText('Name')
    fireEvent.blur(input)
    expect(data.onCommit).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'New' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(data.onCommit).toHaveBeenCalledWith('name', 'New')
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('New'))
  })

  it('takes a new record value over the typed one', () => {
    const data: TaskBoxData = { record: { id: '1', name: 'Old' }, editable: true, fields, onCommit: vi.fn(async () => {}), onOpen: vi.fn() }
    const props = (d: TaskBoxData) => ({ id: '1', data: d }) as unknown as NodeProps<Node<TaskBoxData>>
    const { rerender } = render(<TaskBox {...props(data)} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Typed' } })
    rerender(<TaskBox {...props({ ...data, record: { id: '1', name: 'Saved' } })} />)
    expect(screen.getByLabelText('Name')).toHaveValue('Saved')
  })

  it('double-click opens', () => {
    const onToggle = vi.fn()
    const data = box({ editable: false, badges: <span>badge</span>, footer: <span>foot</span>, chevron: { folded: true, onToggle } })
    expect(screen.getByLabelText('Name')).toBeDisabled()
    fireEvent.doubleClick(screen.getByLabelText('Name'))
    expect(data.onOpen).not.toHaveBeenCalled()
    fireEvent.doubleClick(screen.getByText('badge'))
    expect(data.onOpen).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    expect(onToggle).toHaveBeenCalled()
    expect(screen.getByText('foot')).toBeInTheDocument()
  })
})
