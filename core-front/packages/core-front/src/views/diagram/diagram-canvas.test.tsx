import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import type { Node, NodeProps } from '@xyflow/react'

// React Flow needs real layout (ResizeObserver, sizes) jsdom lacks: like the shell's
// WorkflowMap tests, the stub keeps its props so the tests call the canvas's handlers
// the way React Flow would.
type RfNode = { id: string; type?: string; data?: Record<string, unknown>; position: { x: number; y: number }; measured?: { width: number; height: number }; selected?: boolean }
type RfEdge = { id: string; source: string; target: string; selected?: boolean; data?: unknown }
type RfProps = {
  nodes: RfNode[]
  edges: RfEdge[]
  onEdgesChange?: (c: unknown[]) => void
  onEdgesDelete?: (e: RfEdge[]) => void
  onConnect?: (c: { source: string; target: string }) => void
  nodesConnectable?: boolean
  onNodesChange?: (c: unknown[]) => void
  onNodeDragStop?: (e: unknown, n: RfNode, nodes?: RfNode[]) => void
  selectionKeyCode?: string
  multiSelectionKeyCode?: string
  onInit?: (i: { fitView: () => void }) => void
  children?: ReactNode
}
const rf = vi.hoisted(() => ({ props: null as unknown as RfProps, zoom: 1 }))
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
  useStore: (select: (s: { transform: [number, number, number] }) => unknown) => select({ transform: [0, 0, rf.zoom] }),
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  getNodesBounds: () => ({ x: 0, y: 0, width: 100, height: 50 }),
}))
const exportPng = vi.hoisted(() => vi.fn(async () => {}))
const exportPdf = vi.hoisted(() => vi.fn(async () => {}))
// Counts module loads: the export code must load on the first click, not with the canvas.
const exportLoads = vi.hoisted(() => ({ n: 0 }))
vi.mock('./export', () => {
  exportLoads.n++
  return { exportPng, exportPdf }
})

import { DIAGRAM_RECORD_CAP, DiagramCanvas, DiagramCapNotice, handleSize, trimPositions, useDiagramRecords, type DiagramCanvasProps } from './diagram-canvas'
import { useUndoHistory } from './history'
import { LabelBox, NoteBox, TaskBox, type NoteBoxData, type TaskBoxData } from './task-box'
import { RelationOpsProvider, type RelationOps, type ViewLayout } from '../relation-ops'
import type { EntityListOptions } from '../../api/list-options'
import { translationRegistry } from '../../i18n/registry'
import { useI18nStore } from '../../i18n/i18n-store'

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
  return { saveViewLayout, getViewLayout, props, ops }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('DiagramCanvas', () => {
  it('grows connector dots as the view zooms out', async () => {
    expect(handleSize(1)).toBe(12)
    expect(handleSize(4)).toBe(8)
    expect(handleSize(0.1)).toBeCloseTo(120)
    rf.zoom = 0.5
    setup()
    await flush()
    expect(screen.getByTestId('react-flow').parentElement!.style.getPropertyValue('--handle-size')).toBe('24px')
    rf.zoom = 1
  })

  it('undoes and redoes box moves (Ctrl+Z, Ctrl+Y, toolbar)', async () => {
    const saveViewLayout = vi.fn(async () => {})
    const ops = { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn(), getViewLayout: async () => ({ positions: {}, folded: [] }), saveViewLayout }
    function WithHistory() {
      const history = useUndoHistory()
      return (
        <DiagramCanvas entity="project_task" mode="pert" title="Plan" nodes={[node('a'), node('b')]} edges={[]}
          autoLayout={() => ({ a: at(0, 0), b: at(500, 500) })} legend={[]} history={history} />
      )
    }
    render(<RelationOpsProvider ops={ops}><WithHistory /></RelationOpsProvider>)
    await flush()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    act(() => rf.props.onNodeDragStop!(null, { ...rf.props.nodes[0], position: at(40, 40) }))
    expect(pos('a')).toEqual(at(40, 40))
    await act(async () => fireEvent.keyDown(window, { key: 'z', ctrlKey: true }))
    expect(pos('a')).toEqual(at(0, 0))
    await act(async () => fireEvent.keyDown(window, { key: 'y', ctrlKey: true }))
    expect(pos('a')).toEqual(at(40, 40))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Undo' })))
    expect(pos('a')).toEqual(at(0, 0))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Redo' })))
    expect(pos('a')).toEqual(at(40, 40))
    await act(() => vi.advanceTimersByTimeAsync(600))
    expect(saveViewLayout).toHaveBeenLastCalledWith('project_task', 'pert', expect.objectContaining({ positions: expect.objectContaining({ a: at(40, 40) }) }))
  })

  it('loads the export code only on the first export', async () => {
    setup()
    await flush()
    expect(exportLoads.n).toBe(0)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Export PNG' })))
    expect(exportLoads.n).toBe(1)
  })

  it('places a box by its own declared height (a short WBS group root)', async () => {
    setup({
      nodes: [{ ...node('g'), height: 60 }, node('t')],
      autoLayout: () => ({ g: at(0, 0), t: at(0, 120) }),
    })
    await flush()
    // Taken as a 300px box, g would overlap t and push it down.
    expect(pos('t')).toEqual(at(0, 120))
  })

  it('selects boxes with Shift (click and rectangle) and moves a selection together', async () => {
    const onNodeDrop = vi.fn(() => true)
    const { saveViewLayout } = setup({ onNodeDrop })
    await flush()
    expect(rf.props.selectionKeyCode).toBe('Shift')
    expect(rf.props.multiSelectionKeyCode).toBe('Shift')
    act(() => rf.props.onNodesChange!([{ type: 'select', id: 'a', selected: true }, { type: 'select', id: 'b', selected: true }]))
    expect(rf.props.nodes.map((n) => n.selected)).toEqual([true, true])
    act(() => rf.props.onNodeDragStop!(null, { id: 'a', position: at(100, 100) }, [{ id: 'a', position: at(100, 100) }, { id: 'b', position: at(600, 600) }]))
    expect(pos('a')).toEqual(at(100, 100))
    expect(pos('b')).toEqual(at(600, 600))
    expect(onNodeDrop).not.toHaveBeenCalled() // a group move is layout only
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(saveViewLayout).toHaveBeenCalledWith('project_task', 'wbs', expect.objectContaining({ positions: { a: at(100, 100), b: at(600, 600) } }))
    act(() => rf.props.onNodesChange!([{ type: 'select', id: 'a', selected: false }]))
    expect(rf.props.nodes.map((n) => n.selected)).toEqual([false, true])
  })

  it('keeps a moved selection off each other and the other boxes', async () => {
    setup({ nodes: [node('a'), node('b'), node('c')], autoLayout: () => ({ a: at(0, 0), b: at(500, 0), c: at(1000, 0) }) })
    await flush()
    // a and b dropped onto c's spot, on top of each other.
    act(() => rf.props.onNodeDragStop!(null, { id: 'a', position: at(1000, 0) }, [{ id: 'a', position: at(1000, 0) }, { id: 'b', position: at(1000, 0) }]))
    expect(pos('c')).toEqual(at(1000, 0))
    expect(pos('a')).not.toEqual(at(1000, 0))
    expect(pos('b')).not.toEqual(pos('a'))
  })

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
    // An id not drawn now keeps its saved spot.
    expect(Object.keys(saved.positions).sort()).toEqual(['a', 'b', 'stale'])
    expect(saved.positions.stale).toEqual(at(9, 9))
  })

  it('keeps the spots of boxes hidden since (folded or filtered out) when saving', async () => {
    const saveViewLayout = vi.fn(async () => {})
    const ops = { list: vi.fn(), get: vi.fn(), create: vi.fn(), remove: vi.fn(), getViewLayout: async () => ({ positions: {}, folded: [] }), saveViewLayout }
    const ui = (ids: string[]) => (
      <RelationOpsProvider ops={ops}>
        <DiagramCanvas entity="e" mode="wbs" title="T" nodes={ids.map(node)} edges={[]} autoLayout={() => ({ a: at(0, 0), b: at(500, 0), c: at(1000, 0) })} legend={[]} />
      </RelationOpsProvider>
    )
    const { rerender } = render(ui(['a', 'b', 'c']))
    await flush()
    act(() => rf.props.onNodeDragStop!(null, { id: 'c', position: at(1200, 300) }))
    await act(() => vi.advanceTimersByTimeAsync(500))
    rerender(ui(['a', 'b'])) // c folded away
    act(() => rf.props.onNodeDragStop!(null, { id: 'a', position: at(0, 900) }))
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(saveViewLayout).toHaveBeenLastCalledWith('e', 'wbs', { positions: { a: at(0, 900), b: at(500, 0), c: at(1200, 300) }, folded: [] })
    // Re-arrange resets only the drawn boxes.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Re-arrange' })))
    expect(saveViewLayout).toHaveBeenLastCalledWith('e', 'wbs', { positions: { a: at(0, 0), b: at(500, 0), c: at(1200, 300) }, folded: [] })
  })

  it('keeps unmoved nodes the same objects during a drag', async () => {
    setup()
    await flush()
    const before = rf.props.nodes
    act(() => rf.props.onNodesChange!([{ type: 'position', id: 'a', position: at(40, 40) }]))
    expect(rf.props.nodes[1]).toBe(before[1])
    expect(rf.props.nodes[0]).not.toBe(before[0])
  })

  it('shows an export failure', async () => {
    exportPdf.mockRejectedValueOnce(new Error('canvas too big'))
    setup()
    await flush()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Export PDF' })))
    expect(screen.getByText('canvas too big')).toBeInTheDocument()
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

  it('controlled positions: no layout read or save, drops reported to onMove', async () => {
    const onMove = vi.fn(() => true)
    const { getViewLayout, saveViewLayout } = setup({ positions: { a: at(10, 10), b: at(500, 500) }, onMove })
    await flush()
    expect(pos('a')).toEqual(at(10, 10))
    act(() => rf.props.onNodeDragStop!(null, { id: 'a', position: at(40, 40) }))
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(onMove).toHaveBeenCalledWith({ a: at(40, 40) })
    expect(getViewLayout).not.toHaveBeenCalled()
    expect(saveViewLayout).not.toHaveBeenCalled()
  })

  it('controlled positions: an accepted move lands, a refused one stays put', async () => {
    let verdict = true
    const onMove = vi.fn(async (m: Record<string, { x: number; y: number }>) => (m ? verdict : false))
    function Parent() {
      const [positions, setPositions] = useState({ a: at(10, 10), b: at(500, 500) })
      return (
        <DiagramCanvas
          entity="obs" mode="obs" title="Plan" nodes={[node('a'), node('b')]} edges={[]} legend={[]}
          autoLayout={() => positions} positions={positions}
          onMove={async (m) => {
            const ok = await onMove(m)
            if (ok !== false) setPositions((p) => ({ ...p, ...m }))
            return ok
          }}
        />
      )
    }
    render(<Parent />)
    await flush()
    verdict = false
    act(() => rf.props.onNodeDragStop!(null, { id: 'a', position: at(40, 40) }))
    await flush()
    expect(onMove).toHaveBeenCalledWith({ a: at(40, 40) })
    expect(pos('a')).toEqual(at(10, 10))
    verdict = true
    act(() => rf.props.onNodeDragStop!(null, { id: 'a', position: at(40, 40) }))
    await flush()
    expect(pos('a')).toEqual(at(40, 40))
  })

  it('an obs canvas without positions never reads or saves a layout', async () => {
    const { getViewLayout, saveViewLayout } = setup({ mode: 'obs' })
    await flush()
    act(() => rf.props.onNodeDragStop!(null, { id: 'a', position: at(40, 40) }))
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(getViewLayout).not.toHaveBeenCalled()
    expect(saveViewLayout).not.toHaveBeenCalled()
  })

  it('controlled positions: a rejected Re-arrange move is swallowed', async () => {
    setup({ positions: { a: at(10, 10), b: at(500, 500) }, onMove: () => Promise.reject(new Error('no')) })
    await flush()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Re-arrange' })))
    await flush()
  })

  it('controlled positions: a selection drop and Re-arrange report to onMove', async () => {
    const onMove = vi.fn()
    setup({ positions: { a: at(10, 10), b: at(500, 500) }, onMove })
    await flush()
    act(() => rf.props.onNodeDragStop!(null, { id: 'a', position: at(100, 100) }, [{ id: 'a', position: at(100, 100) }, { id: 'b', position: at(700, 700) }]))
    expect(onMove).toHaveBeenLastCalledWith({ a: at(100, 100), b: at(700, 700) })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Re-arrange' })))
    expect(onMove).toHaveBeenLastCalledWith({ a: at(0, 0), b: at(500, 500) })
  })

  it('reports the box a dragged one was dropped on', async () => {
    const onNodeDrop = vi.fn()
    setup({ onNodeDrop })
    await flush()
    act(() => rf.props.onNodeDragStop!(null, { id: 'a', position: at(510, 510) }))
    expect(onNodeDrop).toHaveBeenCalledWith('a', 'b', expect.objectContaining({ a: expect.anything(), b: expect.anything() }))
    act(() => rf.props.onNodeDragStop!(null, { id: 'a', position: at(2000, 2000) }))
    expect(onNodeDrop).toHaveBeenLastCalledWith('a', null, expect.anything())
  })

  it('adds, links, edits and deletes notes, saved with the layout', async () => {
    const onConnect = vi.fn()
    const onEdgesDelete = vi.fn()
    const layout: ViewLayout = { positions: { n1: at(900, 0) }, folded: [], notes: [{ id: 'n1', text: 'why', links: ['a', 'gone'] }] }
    const { saveViewLayout } = setup({ mode: 'pert', notes: true, onConnect, onEdgesDelete }, layout)
    await flush()
    expect(rf.props.nodesConnectable).toBe(true)
    expect(pos('n1')).toEqual(at(900, 0))
    // A link to a box not drawn stays saved but isn't drawn.
    expect(rf.props.edges.map((e) => [e.source, e.target])).toEqual([['n1', 'a']])

    act(() => fireEvent.click(screen.getByRole('button', { name: 'Add note' })))
    const added = rf.props.nodes.find((n) => n.type === 'note' && n.id !== 'n1')!
    act(() => rf.props.onConnect!({ source: 'b', target: added.id }))
    act(() => rf.props.onConnect!({ source: 'n1', target: added.id })) // note to note: ignored
    act(() => rf.props.onConnect!({ source: 'a', target: 'b' }))
    expect(onConnect).toHaveBeenCalledTimes(1)
    act(() => (added.data as NoteBoxData).onText('hello'))
    act(() => rf.props.onEdgesDelete!(rf.props.edges.filter((e) => e.source === 'n1')))
    expect(onEdgesDelete).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(500))
    const saved = (saveViewLayout.mock.lastCall as unknown as [string, string, ViewLayout])[2]
    expect(saved.notes).toEqual([{ id: 'n1', text: 'why', links: ['gone'] }, { id: added.id, text: 'hello', links: ['b'] }])
    expect(saved.positions[added.id]).toBeDefined()

    act(() => (rf.props.nodes.find((n) => n.id === 'n1')!.data as NoteBoxData).onDelete())
    await act(() => vi.advanceTimersByTimeAsync(500))
    const after = (saveViewLayout.mock.lastCall as unknown as [string, string, ViewLayout])[2]
    expect(after.notes!.map((n) => n.id)).toEqual([added.id])
    expect(after.positions.n1).toBeUndefined()
  })

  it('keeps notes where they are on re-arrange', async () => {
    const { saveViewLayout } = setup({ mode: 'pert', notes: true }, { positions: { n1: at(900, 900) }, folded: [], notes: [{ id: 'n1', text: '', links: [] }] })
    await flush()
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Re-arrange' })))
    expect(pos('n1')).toEqual(at(900, 900))
    expect(saveViewLayout).toHaveBeenLastCalledWith('project_task', 'pert', expect.objectContaining({ notes: [{ id: 'n1', text: '', links: [] }] }))
  })

  it('note box commits its text on blur and deletes from its button', () => {
    const data: NoteBoxData = { text: 'old', onText: vi.fn(), onDelete: vi.fn() }
    render(<NoteBox {...({ data } as unknown as NodeProps<Node<NoteBoxData>>)} />)
    const input = screen.getByRole('textbox', { name: 'Note' })
    fireEvent.change(input, { target: { value: 'new' } })
    fireEvent.blur(input)
    expect(data.onText).toHaveBeenCalledWith('new')
    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }))
    expect(data.onDelete).toHaveBeenCalled()
  })

  it('explains how to use the canvas, with the tips that apply to it', async () => {
    setup({ mode: 'pert', notes: true, onConnect: vi.fn() })
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'How to use this diagram' }))
    expect(screen.getByText(/add a dependency/)).toBeTruthy()
    expect(screen.getByText(/Add note adds a text box/)).toBeTruthy()
    expect(screen.queryByText(/move it under that one/)).toBeNull()
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
    expect(exportPng).toHaveBeenCalledWith(expect.any(HTMLElement), { x: 0, y: 0, width: 100, height: 50 }, 'Plan', '#fff')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Export PDF' })))
    expect(exportPdf).toHaveBeenCalledWith(expect.any(HTMLElement), { x: 0, y: 0, width: 100, height: 50 }, { title: 'Plan', date: expect.any(Date), legend: [{ color: '#ff0000', label: 'Critical' }], background: '#fff' }, 'Plan')
  })
})

describe('DiagramCapNotice', () => {
  afterEach(() => {
    translationRegistry.clear()
    useI18nStore.setState({ locale: null })
  })
  it('translates as one sentence, with the cap in it', () => {
    const msgid = 'More than {n} records match — narrow the filters to draw the diagram'
    translationRegistry.register({ locale: 'fr', module: 'shell', entries: { [msgid]: 'Plus de {n} éléments' } })
    useI18nStore.setState({ locale: 'fr' })
    render(<DiagramCapNotice />)
    expect(screen.getByText(`Plus de ${DIAGRAM_RECORD_CAP} éléments`)).toBeInTheDocument()
  })
})

describe('trimPositions', () => {
  it('keeps every position under the limit, else the drawn ones first', () => {
    const all = { h1: at(1, 1), a: at(0, 0), h2: at(2, 2), b: at(3, 3) }
    expect(trimPositions(all, new Set(['a', 'b']), 4)).toBe(all)
    expect(Object.keys(trimPositions(all, new Set(['a', 'b']), 3)).sort()).toEqual(['a', 'b', 'h1'])
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
  it('is memoized, like LabelBox', () => {
    expect((TaskBox as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'))
    expect((LabelBox as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'))
  })
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
