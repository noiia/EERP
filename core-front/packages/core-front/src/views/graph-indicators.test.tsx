import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type { ReactGridLayoutProps } from 'react-grid-layout'
import { GraphRenderer } from './graph-renderer'
import { GraphOpsProvider, type GraphOps } from './graph-ops'
import { RelationOpsProvider, type RelationOps } from './relation-ops'
import { clearIndicatorCache, indicatorTileData } from './graph-indicators'
import type { Tile } from '../api/graph'
import type { ViewDescriptor } from './descriptor'
import type { EntityListOptions } from '../api/list-options'

vi.mock('react-grid-layout', () => ({
  __esModule: true,
  default: (props: ReactGridLayoutProps) => <div>{props.children}</div>,
  useContainerWidth: () => ({ width: 900, mounted: true, containerRef: { current: null }, measureWidth: () => {} }),
  verticalCompactor: (layout: unknown) => layout,
}))

const descriptor: ViewDescriptor<{ id: string }> = { entity: 'project_task', viewType: 'tree', fields: [{ name: 'name', label: 'Name', type: 'text' }] }
const source = (key: string, unit?: string) => ({ source: { scopeField: 'project_id', scopeEntity: 'project', scopeLabel: 'Project', path: 'indicators', key, ...(unit ? { unit } : {}) } })
const tiles: Tile[] = [
  { id: 'done', x: 0, y: 0, w: 6, h: 4, type: 'stat', title: 'Done', config: source('done_pct', '%') },
  { id: 'cp', x: 6, y: 0, w: 6, h: 4, type: 'stat', title: 'Critical', config: source('critical_path_days', 'd') },
  { id: 'colors', x: 0, y: 4, w: 6, h: 6, type: 'pie', title: 'Colors', config: source('by_color') },
]
const answer = {
  done_pct: 100 / 3,
  critical_path_days: null,
  by_color: [{ label: 'Red', value: 2, color: '#ff0000' }, { label: 'No color group', value: 1 }],
}

function setup(listOptions: EntityListOptions | undefined) {
  const get = vi.fn(async () => answer)
  const graphOps: GraphOps = { get: vi.fn(async () => ({ tiles })), save: vi.fn(), aggregate: vi.fn(async () => null) }
  render(
    <RelationOpsProvider ops={{ list: vi.fn(), get, create: vi.fn(), remove: vi.fn() } as unknown as RelationOps}>
      <GraphOpsProvider ops={graphOps}>
        <GraphRenderer descriptor={descriptor} records={[]} listOptions={listOptions} />
      </GraphOpsProvider>
    </RelationOpsProvider>,
  )
  return { get, graphOps }
}

describe('indicator tiles', () => {
  beforeEach(() => clearIndicatorCache())

  it('turns an indicator into a stat or pie slices (colors kept when hex)', () => {
    expect(indicatorTileData(answer, 'done_pct')).toEqual({ stat: 100 / 3 })
    expect(indicatorTileData(answer, 'critical_path_days')).toEqual({ stat: null })
    expect(indicatorTileData(null, 'done_pct')).toEqual({ stat: null })
    expect(indicatorTileData({ p: [{ label: 'A', value: 2, color: 'red' }] }, 'p')).toEqual({ slices: [{ label: 'A', count: 2, displayValue: 2 }] })
  })

  it('reads the pinned project\'s indicators once and draws them, a missing value as no data', async () => {
    const { get, graphOps } = setup({ filter: { project_id: 'p1' } })
    const done = await screen.findByTestId('graph-tile-done')
    expect(await within(done).findByText('33.3 %')).toBeInTheDocument()
    expect(within(screen.getByTestId('graph-tile-cp')).queryByText(/d$/)).toBeNull()
    expect(await within(screen.getByTestId('graph-tile-colors')).findByText('Red')).toBeInTheDocument()
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('project', 'p1/indicators')
    // Never aggregated over the list's rows.
    expect(graphOps.aggregate).not.toHaveBeenCalled()
  })

  it('asks to filter on one project when the list is not pinned', async () => {
    const { get } = setup(undefined)
    expect(await within(await screen.findByTestId('graph-tile-done')).findByText('Filter the list on one project to see this.')).toBeInTheDocument()
    expect(get).not.toHaveBeenCalled()
  })
})
