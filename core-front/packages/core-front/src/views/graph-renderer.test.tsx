import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactGridLayoutProps } from 'react-grid-layout'
import { GraphRenderer, applyRGLLayout } from './graph-renderer'
import { GraphOpsProvider, type GraphOps } from './graph-ops'
import type { GraphLayout, Tile } from '../api/graph'
import type { ViewDescriptor } from './descriptor'
import { useSessionStore, type Identity } from './session-store'

// react-grid-layout's actual drag/resize (react-draggable/react-resizable) measure
// real DOM geometry (getBoundingClientRect), which jsdom always reports as a zero
// rect — there is no event-simulation path to drive it (this is exactly the
// jsdom-testability concern docs/roadmaps/list-view-modes.md's Architecture
// Decision #7 named). So we mock at the COMPONENT boundary instead of the DOM-event
// boundary: capture the props GraphRenderer hands to <ReactGridLayout>, assert on
// those, and drive onLayoutChange directly to simulate "a drag/resize just
// finished." Real compaction/collision behavior is NOT covered here — see the
// real-browser verification pass in the roadmap doc instead.
let capturedRGLProps: ReactGridLayoutProps | null = null

vi.mock('react-grid-layout', () => ({
  __esModule: true,
  default: (props: ReactGridLayoutProps) => {
    capturedRGLProps = props
    return <div data-testid="rgl-mock">{props.children}</div>
  },
  useContainerWidth: () => ({
    width: 900,
    mounted: true,
    containerRef: { current: null },
    measureWidth: () => {},
  }),
  verticalCompactor: (layout: unknown) => layout,
}))

/** The most recent props GraphRenderer handed to the mocked <ReactGridLayout>. */
function rgl(): ReactGridLayoutProps {
  if (!capturedRGLProps) throw new Error('ReactGridLayout has not rendered yet')
  return capturedRGLProps
}

interface Deal {
  id: string
  name: string
}

const descriptor: ViewDescriptor<Deal> = {
  entity: 'crm',
  viewType: 'tree',
  fields: [{ name: 'name', label: 'Name', type: 'text' }],
}

function identityWith(permissions: string[]): Identity {
  return { userId: 'u1', tenantId: 't1', roles: ['tester'], permissions }
}

function fakeOps(overrides: Partial<GraphOps> = {}): GraphOps {
  return {
    get: vi.fn(async () => ({ tiles: [] }) as GraphLayout),
    save: vi.fn(async () => ({ ok: true }) as const),
    ...overrides,
  }
}

async function pickWidgetType(name: string) {
  fireEvent.mouseDown(screen.getByLabelText('Widget type'))
  fireEvent.click(await screen.findByRole('option', { name }))
}

const savedTile: Tile = { id: 't1', x: 0, y: 0, w: 6, h: 6, type: 'stat', title: 'Revenue', config: {} }

describe('GraphRenderer', () => {
  beforeEach(() => {
    useSessionStore.setState({ identity: null })
    capturedRGLProps = null
  })

  it('renders an inert message with no crash when no GraphOpsProvider is mounted', () => {
    render(<GraphRenderer descriptor={descriptor} records={[]} />)
    expect(screen.getByText(/Graph layouts are not available/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('loads the saved layout and renders it read-only without write permission', async () => {
    const ops = fakeOps({ get: vi.fn(async () => ({ tiles: [savedTile] })) })
    render(
      <GraphOpsProvider ops={ops}>
        <GraphRenderer descriptor={descriptor} records={[]} />
      </GraphOpsProvider>,
    )
    await waitFor(() => expect(ops.get).toHaveBeenCalledWith('crm'))
    expect(await screen.findByTestId('graph-tile-t1')).toHaveTextContent('Revenue')
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hide widget' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '+ Add widget' })).not.toBeInTheDocument()
    expect(rgl().dragConfig!.enabled).toBe(false)
    expect(rgl().resizeConfig!.enabled).toBe(false)
  })

  it('shows Edit only for a session granted settings:views:write', async () => {
    useSessionStore.setState({ identity: identityWith(['settings:views:write']) })
    render(
      <GraphOpsProvider ops={fakeOps()}>
        <GraphRenderer descriptor={descriptor} records={[]} />
      </GraphOpsProvider>,
    )
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument()
  })

  it('the grid uses a fixed GRID_UNIT row height and a container-width-derived column count', async () => {
    useSessionStore.setState({ identity: identityWith(['settings:views:write']) })
    render(
      <GraphOpsProvider ops={fakeOps({ get: vi.fn(async () => ({ tiles: [savedTile] })) })}>
        <GraphRenderer descriptor={descriptor} records={[]} />
      </GraphOpsProvider>,
    )
    await screen.findByTestId('graph-tile-t1')
    // useContainerWidth is mocked to 900px; cols = round(900/30) = 30.
    expect(rgl().gridConfig).toMatchObject({ cols: 30, rowHeight: 30 })
  })

  it('edit mode enables drag/resize and reveals Hide/Configure/Add widget; view mode has none', async () => {
    useSessionStore.setState({ identity: identityWith(['settings:views:write']) })
    render(
      <GraphOpsProvider ops={fakeOps({ get: vi.fn(async () => ({ tiles: [savedTile] })) })}>
        <GraphRenderer descriptor={descriptor} records={[]} />
      </GraphOpsProvider>,
    )
    await screen.findByTestId('graph-tile-t1')
    expect(rgl().dragConfig!.enabled).toBe(false)
    expect(rgl().resizeConfig!.enabled).toBe(false)
    expect(screen.queryByRole('button', { name: 'Hide widget' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(rgl().dragConfig!.enabled).toBe(true)
    expect(rgl().resizeConfig!.enabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Configure widget' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide widget' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ Add widget' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('the whole tile is the drag surface, and resize is enabled from all 8 handles', async () => {
    useSessionStore.setState({ identity: identityWith(['settings:views:write']) })
    render(
      <GraphOpsProvider ops={fakeOps({ get: vi.fn(async () => ({ tiles: [savedTile] })) })}>
        <GraphRenderer descriptor={descriptor} records={[]} />
      </GraphOpsProvider>,
    )
    await screen.findByTestId('graph-tile-t1')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    // No dragConfig.handle: there's no dedicated header anymore, so RGL's default
    // (an unset/empty handle selector) makes the entire tile draggable.
    expect(rgl().dragConfig!.handle).toBeUndefined()
    expect(rgl().dragConfig!.cancel).toBe('.graph-tile-no-drag')
    expect(rgl().resizeConfig!.handles).toEqual(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'])
  })

  it('the tile has no header bar, a 5px gap from its occupied cell, and 16px rounded corners', async () => {
    render(
      <GraphOpsProvider ops={fakeOps({ get: vi.fn(async () => ({ tiles: [savedTile] })) })}>
        <GraphRenderer descriptor={descriptor} records={[]} />
      </GraphOpsProvider>,
    )
    const cell = await screen.findByTestId('graph-tile-t1')
    expect(screen.queryByTestId('graph-tile-header-t1')).not.toBeInTheDocument()
    const card = cell.firstElementChild as HTMLElement
    expect(card).toHaveStyle({ borderRadius: '16px', inset: '5px' })
    // The title renders at a larger variant than the old header's "caption" one.
    expect(screen.getByText('Revenue')).toHaveClass('MuiTypography-subtitle1')
  })

  it('each tile\'s layout item carries its type\'s minimum size', async () => {
    useSessionStore.setState({ identity: identityWith(['settings:views:write']) })
    const pieTile: Tile = { id: 't2', x: 0, y: 6, w: 6, h: 6, type: 'pie', config: {} }
    render(
      <GraphOpsProvider ops={fakeOps({ get: vi.fn(async () => ({ tiles: [savedTile, pieTile] })) })}>
        <GraphRenderer descriptor={descriptor} records={[]} />
      </GraphOpsProvider>,
    )
    await screen.findByTestId('graph-tile-t1')
    const statItem = rgl().layout!.find((item: { i: string }) => item.i === 't1')
    const pieItem = rgl().layout!.find((item: { i: string }) => item.i === 't2')
    expect(statItem).toMatchObject({ minW: 2, minH: 2 })
    expect(pieItem).toMatchObject({ minW: 5, minH: 5 })
  })

  it('adding a widget appends a tile at the type/title chosen in the dialog', async () => {
    useSessionStore.setState({ identity: identityWith(['settings:views:write']) })
    render(
      <GraphOpsProvider ops={fakeOps({ get: vi.fn(async () => ({ tiles: [savedTile] })) })}>
        <GraphRenderer descriptor={descriptor} records={[]} />
      </GraphOpsProvider>,
    )
    await screen.findByTestId('graph-tile-t1')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: '+ Add widget' }))

    await pickWidgetType('pie')
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'By region' } })
    fireEvent.mouseDown(screen.getByLabelText('Group by field'))
    fireEvent.click(await screen.findByRole('option', { name: 'Name' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    const cards = screen.getAllByTestId(/^graph-tile-(?!header-)/)
    const added = cards.find((el) => el.getAttribute('data-testid') !== 'graph-tile-t1')!
    expect(added).toHaveTextContent('By region')
    // Stacks below the existing tile (y = savedTile.y + savedTile.h = 6).
    const addedItem = rgl().layout!.find((item: { i: string }) => item.i !== 't1')
    expect(addedItem).toMatchObject({ x: 0, y: 6, minW: 5, minH: 5 })
  })

  it('hiding a tile removes it from the grid and lists it as a restorable chip', async () => {
    useSessionStore.setState({ identity: identityWith(['settings:views:write']) })
    render(
      <GraphOpsProvider ops={fakeOps({ get: vi.fn(async () => ({ tiles: [savedTile] })) })}>
        <GraphRenderer descriptor={descriptor} records={[]} />
      </GraphOpsProvider>,
    )
    await screen.findByTestId('graph-tile-t1')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide widget' }))

    expect(screen.queryByTestId('graph-tile-t1')).not.toBeInTheDocument()
    expect(rgl().layout!).toEqual([])
    expect(screen.getByTestId('graph-hidden-chip-t1')).toHaveTextContent('Revenue')
  })

  it('restoring a hidden tile via its chip brings it back to its prior geometry', async () => {
    useSessionStore.setState({ identity: identityWith(['settings:views:write']) })
    render(
      <GraphOpsProvider ops={fakeOps({ get: vi.fn(async () => ({ tiles: [savedTile] })) })}>
        <GraphRenderer descriptor={descriptor} records={[]} />
      </GraphOpsProvider>,
    )
    await screen.findByTestId('graph-tile-t1')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide widget' }))
    fireEvent.click(screen.getByTestId('graph-hidden-chip-t1'))

    expect(screen.queryByTestId('graph-hidden-chip-t1')).not.toBeInTheDocument()
    expect(await screen.findByTestId('graph-tile-t1')).toHaveTextContent('Revenue')
    const restoredItem = rgl().layout!.find((item: { i: string }) => item.i === 't1')
    expect(restoredItem).toMatchObject({ x: 0, y: 0, w: 6, h: 6 })
  })

  it('a hidden tile is excluded from Save\'s payload geometry changes but keeps its config', async () => {
    useSessionStore.setState({ identity: identityWith(['settings:views:write']) })
    const save = vi.fn(async () => ({ ok: true }) as const)
    render(
      <GraphOpsProvider ops={fakeOps({ get: vi.fn(async () => ({ tiles: [savedTile] })), save })}>
        <GraphRenderer descriptor={descriptor} records={[]} />
      </GraphOpsProvider>,
    )
    await screen.findByTestId('graph-tile-t1')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide widget' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(save).toHaveBeenCalledWith('crm', [{ ...savedTile, hidden: true }]))
  })

  it('onLayoutChange updates the draft; Save persists the merged geometry', async () => {
    useSessionStore.setState({ identity: identityWith(['settings:views:write']) })
    const save = vi.fn(async () => ({ ok: true }) as const)
    render(
      <GraphOpsProvider ops={fakeOps({ get: vi.fn(async () => ({ tiles: [savedTile] })), save })}>
        <GraphRenderer descriptor={descriptor} records={[]} />
      </GraphOpsProvider>,
    )
    await screen.findByTestId('graph-tile-t1')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    // Simulate "a drag/resize just finished" the way RGL itself would report it.
    act(() => rgl().onLayoutChange!([{ i: 't1', x: 2, y: 0, w: 6, h: 6 }]))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(save).toHaveBeenCalledWith('crm', [{ ...savedTile, x: 2, y: 0 }]))
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument()
  })

  it('onLayoutChange is a no-op outside edit mode', async () => {
    useSessionStore.setState({ identity: identityWith(['settings:views:write']) })
    render(
      <GraphOpsProvider ops={fakeOps({ get: vi.fn(async () => ({ tiles: [savedTile] })) })}>
        <GraphRenderer descriptor={descriptor} records={[]} />
      </GraphOpsProvider>,
    )
    await screen.findByTestId('graph-tile-t1')
    // View mode: no editing draft to mutate, even if the (inert) grid reports a change.
    act(() => rgl().onLayoutChange!([{ i: 't1', x: 2, y: 0, w: 6, h: 6 }]))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const item = rgl().layout!.find((i: { i: string }) => i.i === 't1')
    expect(item).toMatchObject({ x: 0, y: 0 })
  })

  it('Cancel discards the in-progress edit', async () => {
    useSessionStore.setState({ identity: identityWith(['settings:views:write']) })
    const save = vi.fn(async () => ({ ok: true }) as const)
    render(
      <GraphOpsProvider ops={fakeOps({ get: vi.fn(async () => ({ tiles: [savedTile] })), save })}>
        <GraphRenderer descriptor={descriptor} records={[]} />
      </GraphOpsProvider>,
    )
    await screen.findByTestId('graph-tile-t1')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    act(() => rgl().onLayoutChange!([{ i: 't1', x: 3, y: 0, w: 6, h: 6 }]))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(save).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    // Re-entering Edit re-seeds the draft from the last SAVED layout, not the discarded one.
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const item = rgl().layout!.find((i: { i: string }) => i.i === 't1')
    expect(item).toMatchObject({ x: 0, y: 0 })
  })

  it('a rejected Save keeps the draft and surfaces the error', async () => {
    useSessionStore.setState({ identity: identityWith(['settings:views:write']) })
    const save = vi.fn(async () => ({ ok: false, message: 'Forbidden' }) as const)
    render(
      <GraphOpsProvider ops={fakeOps({ get: vi.fn(async () => ({ tiles: [savedTile] })), save })}>
        <GraphRenderer descriptor={descriptor} records={[]} />
      </GraphOpsProvider>,
    )
    await screen.findByTestId('graph-tile-t1')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Forbidden')).toBeInTheDocument()
    // Still editing: Save/Cancel remain, the draft was not discarded.
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })
})

describe('applyRGLLayout', () => {
  const tiles: Tile[] = [
    { id: 't1', x: 0, y: 0, w: 6, h: 6, type: 'stat', config: {} },
    { id: 't2', x: 6, y: 0, w: 4, h: 4, type: 'pie', config: {}, hidden: true },
  ]

  it('merges reported x/y/w/h onto the matching tile by id', () => {
    const result = applyRGLLayout(tiles, [{ i: 't1', x: 2, y: 1, w: 8, h: 7 }])
    expect(result.find((t) => t.id === 't1')).toMatchObject({ x: 2, y: 1, w: 8, h: 7 })
  })

  it('leaves a tile absent from the reported layout (hidden, not rendered) untouched', () => {
    const result = applyRGLLayout(tiles, [{ i: 't1', x: 2, y: 1, w: 8, h: 7 }])
    expect(result.find((t) => t.id === 't2')).toEqual(tiles[1])
  })

  it('preserves title/type/config, only replacing geometry', () => {
    const withTitle: Tile[] = [{ id: 't1', x: 0, y: 0, w: 6, h: 6, type: 'stat', title: 'Revenue', config: { a: 1 } }]
    const result = applyRGLLayout(withTitle, [{ i: 't1', x: 3, y: 3, w: 3, h: 3 }])
    expect(result[0]).toEqual({ id: 't1', x: 3, y: 3, w: 3, h: 3, type: 'stat', title: 'Revenue', config: { a: 1 } })
  })
})
