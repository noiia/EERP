import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Block } from '@/website/types'
import type { WfPage } from '@/website/workflow'

// React Flow's canvas needs real layout (ResizeObserver, sizes) jsdom lacks: the stub
// renders the nodes/edges it is given and keeps its props, so the tests drive the
// map's own handlers (onNodeClick, onReconnect) the way React Flow would call them.
type RfNode = { id: string; data: { label: ReactNode }; selected?: boolean }
type RfEdge = { id: string; source: string; target: string; selected?: boolean; style?: { stroke?: string } }
type RfProps = {
  nodes: RfNode[]
  edges: RfEdge[]
  onNodeClick?: (e: unknown, n: RfNode) => void
  onReconnect?: (old: RfEdge, conn: { source: string; target: string; sourceHandle: null; targetHandle: null }) => void
}
const rf = vi.hoisted(() => ({ props: null as unknown as RfProps }))
vi.mock('@xyflow/react', () => ({
  ReactFlow: (props: RfProps & { children?: ReactNode }) => {
    rf.props = props
    return (
      <div>
        {props.nodes.map((n) => (
          <button key={n.id} data-testid={`node-${n.id}`} onClick={(e) => props.onNodeClick?.(e, n)}>{n.data.label}</button>
        ))}
        {props.edges.map((e) => (
          <span key={e.id} data-testid={`edge-${e.id}`} data-target={e.target} data-selected={String(!!e.selected)} />
        ))}
        {props.children}
      </div>
    )
  },
  Background: () => null,
  Controls: () => null,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: { Left: 'left', Right: 'right' },
}))
vi.mock('@xyflow/react/dist/style.css', () => ({}))

const push = vi.fn()
const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh, prefetch: vi.fn() }) }))

const getPageLayout = vi.fn<(id: string) => Promise<Block[] | null>>()
const saveLayout = vi.fn<(id: string, layout: Block[]) => Promise<string | null>>()
vi.mock('@/website/editor-actions', () => ({
  getPageLayout: (id: string) => getPageLayout(id),
  saveLayout: (id: string, layout: Block[]) => saveLayout(id, layout),
}))

import { WorkflowMap } from './WorkflowMap'

const hero = (href: string, next = ''): Block => ({ id: 'h1', type: 'hero', x: 0, y: 0, w: 36, h: 10, config: { cta_label: 'Go', cta_href: href, cta_next: next } })
const pages: WfPage[] = [
  { id: 'p-home', slug: '', title: 'Home', published: true, in_menu: true, layout: [hero('/about')] },
  { id: 'p-about', slug: 'about', title: 'About', published: true, in_menu: true, layout: [hero('/login', 'gone')] },
  { id: 'p-contact', slug: 'contact', title: 'Contact', published: true, in_menu: false, layout: [] },
]
const homeEdge = 'p-home:h1:cta_href'

beforeEach(() => {
  push.mockReset(); refresh.mockReset(); getPageLayout.mockReset(); saveLayout.mockReset()
})

describe('WorkflowMap', () => {
  it('renders a node per page plus the system and missing nodes', () => {
    render(<WorkflowMap pages={pages} />)
    for (const id of ['page:', 'page:about', 'page:contact', 'sys:login', 'page:gone']) {
      expect(screen.getByTestId(`node-${id}`)).toBeInTheDocument()
    }
    expect(screen.getByTestId('node-page:')).toHaveTextContent('Home')
  })

  it('opens a page in the builder on click; system and missing nodes are not clickable', () => {
    render(<WorkflowMap pages={pages} />)
    fireEvent.click(screen.getByTestId('node-page:about'))
    expect(push).toHaveBeenCalledWith('/app/website/pages/p-about/design')
    push.mockReset()
    fireEvent.click(screen.getByTestId('node-sys:login'))
    fireEvent.click(screen.getByTestId('node-page:gone'))
    expect(push).not.toHaveBeenCalled()
  })

  it('re-targets a dragged edge on the freshly read layout and saves it', async () => {
    // The page changed since the map loaded: an extra block exists. The save must keep it.
    const extra: Block = { id: 't1', type: 'text', x: 0, y: 10, w: 36, h: 2, config: { body: 'new' } }
    getPageLayout.mockResolvedValue([hero('/about'), extra])
    saveLayout.mockResolvedValue(null)
    render(<WorkflowMap pages={pages} />)
    const old = rf.props.edges.find((e) => e.id === homeEdge)!
    await act(async () => rf.props.onReconnect!(old, { source: 'page:', target: 'page:contact', sourceHandle: null, targetHandle: null }))
    expect(getPageLayout).toHaveBeenCalledWith('p-home')
    expect(saveLayout).toHaveBeenCalledWith('p-home', [hero('/contact'), extra])
    await waitFor(() => expect(screen.getByTestId(`edge-${homeEdge}`)).toHaveAttribute('data-target', 'page:contact'))
    expect(refresh).toHaveBeenCalled()
  })

  it('shows the error and snaps the edge back when the save fails', async () => {
    getPageLayout.mockResolvedValue([hero('/about')])
    saveLayout.mockResolvedValue('slug is reserved')
    render(<WorkflowMap pages={pages} />)
    const old = rf.props.edges.find((e) => e.id === homeEdge)!
    await act(async () => rf.props.onReconnect!(old, { source: 'page:', target: 'page:contact', sourceHandle: null, targetHandle: null }))
    expect(await screen.findByText('slug is reserved')).toBeInTheDocument()
    expect(screen.getByTestId(`edge-${homeEdge}`)).toHaveAttribute('data-target', 'page:about')
  })

  it('snaps back without saving when the drop is refused', async () => {
    getPageLayout.mockResolvedValue([hero('/about')])
    render(<WorkflowMap pages={pages} />)
    const nextEdge = rf.props.edges.find((e) => e.id === 'p-about:h1:cta_href:next')!
    // cta_next is a slug: it can't point at the login page.
    await act(async () => rf.props.onReconnect!(nextEdge, { source: 'sys:login', target: 'sys:login', sourceHandle: null, targetHandle: null }))
    expect(saveLayout).not.toHaveBeenCalled()
    expect(screen.getByTestId('edge-p-about:h1:cta_href:next')).toHaveAttribute('data-target', 'page:gone')
  })

  it('lists problems and highlights the edge of the one clicked', () => {
    render(<WorkflowMap pages={pages} />)
    const item = screen.getByRole('button', { name: /link to a page that doesn't exist/i })
    expect(screen.getByTestId('edge-p-about:h1:cta_href:next')).toHaveAttribute('data-selected', 'false')
    fireEvent.click(item)
    expect(screen.getByTestId('edge-p-about:h1:cta_href:next')).toHaveAttribute('data-selected', 'true')
  })
})
