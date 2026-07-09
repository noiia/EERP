import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GraphRenderer } from './graph-renderer'
import { GraphOpsProvider, type GraphOps } from './graph-ops'
import { GRID_UNIT, type GraphLayout, type Tile } from '../api/graph'
import type { ViewDescriptor } from './descriptor'
import { useSessionStore, type Identity } from './session-store'

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

/** Pixel-delta drag: fires mousedown at (0,0), mousemove at (dx,dy), mouseup —
 * exercises the SAME clientX/clientY-delta math GraphRenderer's drag handler
 * uses. No real layout measurement involved, so this works in jsdom. */
function drag(testId: string, dx: number, dy: number) {
  fireEvent.mouseDown(screen.getByTestId(testId), { clientX: 0, clientY: 0 })
  fireEvent.mouseMove(window, { clientX: dx, clientY: dy })
  fireEvent.mouseUp(window)
}

async function pickWidgetType(name: string) {
  fireEvent.mouseDown(screen.getByLabelText('Widget type'))
  fireEvent.click(await screen.findByRole('option', { name }))
}

const savedTile: Tile = { id: 't1', x: 0, y: 0, w: 6, h: 6, type: 'stat', title: 'Revenue', config: {} }

describe('GraphRenderer', () => {
  beforeEach(() => {
    useSessionStore.setState({ identity: null })
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
    expect(screen.queryByTestId('graph-tile-resize-t1')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '+ Add widget' })).not.toBeInTheDocument()
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

  it('edit mode reveals resize handles, remove buttons, and Add widget; view mode has none', async () => {
    useSessionStore.setState({ identity: identityWith(['settings:views:write']) })
    render(
      <GraphOpsProvider ops={fakeOps({ get: vi.fn(async () => ({ tiles: [savedTile] })) })}>
        <GraphRenderer descriptor={descriptor} records={[]} />
      </GraphOpsProvider>,
    )
    await screen.findByTestId('graph-tile-t1')
    expect(screen.queryByTestId('graph-tile-resize-t1')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByTestId('graph-tile-resize-t1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove widget' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ Add widget' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
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

    // Both tile cards match /^graph-tile-/, but so do their header/resize
    // sub-elements — filter to the CARD testids only, then to the new one.
    const cards = screen.getAllByTestId(/^graph-tile-(?!header-)(?!resize-)/)
    const added = cards.find((el) => el.getAttribute('data-testid') !== 'graph-tile-t1')!
    expect(added).toHaveTextContent('By region')
    // Stacks below the existing tile (y = savedTile.y + savedTile.h = 6).
    expect(added.style.top).toBe(`${6 * GRID_UNIT}px`)
    expect(added.style.left).toBe('0px')
  })

  it('dragging a tile header moves it by whole grid units', async () => {
    useSessionStore.setState({ identity: identityWith(['settings:views:write']) })
    render(
      <GraphOpsProvider ops={fakeOps({ get: vi.fn(async () => ({ tiles: [savedTile] })) })}>
        <GraphRenderer descriptor={descriptor} records={[]} />
      </GraphOpsProvider>,
    )
    await screen.findByTestId('graph-tile-t1')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    drag('graph-tile-header-t1', GRID_UNIT * 2, GRID_UNIT)
    const tile = screen.getByTestId('graph-tile-t1')
    expect(tile.style.left).toBe(`${2 * GRID_UNIT}px`)
    expect(tile.style.top).toBe(`${1 * GRID_UNIT}px`)
  })

  it('a move never goes negative — clamps at the canvas edge', async () => {
    useSessionStore.setState({ identity: identityWith(['settings:views:write']) })
    render(
      <GraphOpsProvider ops={fakeOps({ get: vi.fn(async () => ({ tiles: [savedTile] })) })}>
        <GraphRenderer descriptor={descriptor} records={[]} />
      </GraphOpsProvider>,
    )
    await screen.findByTestId('graph-tile-t1')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    drag('graph-tile-header-t1', -GRID_UNIT * 5, -GRID_UNIT * 5)
    const tile = screen.getByTestId('graph-tile-t1')
    expect(tile.style.left).toBe('0px')
    expect(tile.style.top).toBe('0px')
  })

  it('dragging the resize handle changes width/height by whole grid units, floored at the minimum', async () => {
    useSessionStore.setState({ identity: identityWith(['settings:views:write']) })
    render(
      <GraphOpsProvider ops={fakeOps({ get: vi.fn(async () => ({ tiles: [savedTile] })) })}>
        <GraphRenderer descriptor={descriptor} records={[]} />
      </GraphOpsProvider>,
    )
    await screen.findByTestId('graph-tile-t1')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    drag('graph-tile-resize-t1', GRID_UNIT * 2, GRID_UNIT * 3)
    const tile = screen.getByTestId('graph-tile-t1')
    expect(tile.style.width).toBe(`${8 * GRID_UNIT}px`) // 6 + 2
    expect(tile.style.height).toBe(`${9 * GRID_UNIT}px`) // 6 + 3

    // Shrinking far past zero floors at MIN_TILE_UNITS (2), never collapses to 0.
    drag('graph-tile-resize-t1', -GRID_UNIT * 20, -GRID_UNIT * 20)
    expect(tile.style.width).toBe(`${2 * GRID_UNIT}px`)
    expect(tile.style.height).toBe(`${2 * GRID_UNIT}px`)
  })

  it('removing a tile drops it from the draft', async () => {
    useSessionStore.setState({ identity: identityWith(['settings:views:write']) })
    render(
      <GraphOpsProvider ops={fakeOps({ get: vi.fn(async () => ({ tiles: [savedTile] })) })}>
        <GraphRenderer descriptor={descriptor} records={[]} />
      </GraphOpsProvider>,
    )
    await screen.findByTestId('graph-tile-t1')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove widget' }))
    expect(screen.queryByTestId('graph-tile-t1')).not.toBeInTheDocument()
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
    drag('graph-tile-header-t1', GRID_UNIT * 3, 0)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(save).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    const tile = screen.getByTestId('graph-tile-t1')
    expect(tile.style.left).toBe('0px') // reverted to the saved position
  })

  it('Save persists the draft and a subsequent load reflects it', async () => {
    useSessionStore.setState({ identity: identityWith(['settings:views:write']) })
    const save = vi.fn(async () => ({ ok: true }) as const)
    const get = vi.fn(async () => ({ tiles: [savedTile] }))
    render(
      <GraphOpsProvider ops={fakeOps({ get, save })}>
        <GraphRenderer descriptor={descriptor} records={[]} />
      </GraphOpsProvider>,
    )
    await screen.findByTestId('graph-tile-t1')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    drag('graph-tile-header-t1', GRID_UNIT * 2, 0)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('crm', [{ ...savedTile, x: 2, y: 0 }]),
    )
    // Back to view mode, no drag affordance, moved tile still shown.
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.queryByTestId('graph-tile-resize-t1')).not.toBeInTheDocument()
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
