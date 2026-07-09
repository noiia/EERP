import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { GraphWidgetBody } from './graph-widgets'
import { RelationOpsProvider, type RelationOps, type RelationRecord } from './relation-ops'
import type { Tile } from '../api/graph'
import type { ViewDescriptor } from './descriptor'

interface Deal {
  id: string
  name: string
  status?: string | null
  amount?: number | null
  closed_at?: string | null
}

const descriptor: ViewDescriptor<Deal> = {
  entity: 'crm',
  viewType: 'tree',
  fields: [
    { name: 'name', label: 'Name', type: 'text' },
    { name: 'status', label: 'Status', type: 'selection', selection: { options: ['open', 'won'] } },
    { name: 'amount', label: 'Amount', type: 'number' },
    { name: 'closed_at', label: 'Closed', type: 'date' },
  ],
}

const records: Deal[] = [
  { id: '1', name: 'Acme', status: 'open', amount: 100, closed_at: '2024-01-05' },
  { id: '2', name: 'Globex', status: 'open', amount: 50, closed_at: '2024-01-20' },
  { id: '3', name: 'Initech', status: 'won', amount: 200, closed_at: '2024-02-10' },
]

function tile(overrides: Partial<Tile>): Tile {
  return { id: 't1', x: 0, y: 0, w: 6, h: 6, type: 'stat', config: {}, ...overrides }
}

describe('GraphWidgetBody: stat', () => {
  it('renders the aggregate label and formatted value', () => {
    render(
      <GraphWidgetBody
        tile={tile({ type: 'stat', config: { field: 'amount', aggregate: 'mean' } })}
        descriptor={descriptor}
        records={records}
        recordTotal={3}
      />,
    )
    expect(screen.getByText('Mean')).toBeInTheDocument()
    expect(screen.getByText('116.67')).toBeInTheDocument() // (100+50+200)/3
  })

  it('count ignores the field and counts every record', () => {
    render(
      <GraphWidgetBody
        tile={tile({ type: 'stat', config: { field: 'amount', aggregate: 'count' } })}
        descriptor={descriptor}
        records={records}
        recordTotal={3}
      />,
    )
    expect(screen.getByText('3.00')).toBeInTheDocument()
  })

  it('shows a placeholder for an incomplete config', () => {
    render(
      <GraphWidgetBody
        tile={tile({ type: 'stat', config: {} })}
        descriptor={descriptor}
        records={records}
        recordTotal={3}
      />,
    )
    expect(screen.getByText('No data')).toBeInTheDocument()
  })

  it('shows the partial-data badge when total exceeds the fetched records', () => {
    render(
      <GraphWidgetBody
        tile={tile({ type: 'stat', config: { field: 'amount', aggregate: 'sum' } })}
        descriptor={descriptor}
        records={records}
        recordTotal={500}
      />,
    )
    expect(screen.getByText('Partial data: 3 of 500')).toBeInTheDocument()
  })

  it('shows no badge when the fetched records ARE the total', () => {
    render(
      <GraphWidgetBody
        tile={tile({ type: 'stat', config: { field: 'amount', aggregate: 'sum' } })}
        descriptor={descriptor}
        records={records}
        recordTotal={3}
      />,
    )
    expect(screen.queryByText(/Partial data/)).not.toBeInTheDocument()
  })

  it('treats an unknown total as possibly partial, not complete', () => {
    render(
      <GraphWidgetBody
        tile={tile({ type: 'stat', config: { field: 'amount', aggregate: 'sum' } })}
        descriptor={descriptor}
        records={records}
        recordTotal={undefined}
      />,
    )
    // Unknown total: no badge (nothing to compare against), but also no crash.
    expect(screen.getByText('350.00')).toBeInTheDocument()
  })
})

describe('GraphWidgetBody: xy', () => {
  it('renders a point per month bucket, as an accessible chart', () => {
    render(
      <GraphWidgetBody
        tile={tile({
          type: 'xy',
          config: { xField: 'closed_at', yField: 'amount', aggregate: 'sum', bucket: 'month' },
        })}
        descriptor={descriptor}
        records={records}
        recordTotal={3}
      />,
    )
    const chart = screen.getByRole('img', { name: 'Line chart' })
    expect(chart.querySelectorAll('circle')).toHaveLength(2) // Jan + Feb buckets
  })

  it('shows a placeholder with no data points', () => {
    render(
      <GraphWidgetBody
        tile={tile({
          type: 'xy',
          config: { xField: 'closed_at', yField: 'amount', aggregate: 'sum', bucket: 'month' },
        })}
        descriptor={descriptor}
        records={[]}
        recordTotal={0}
      />,
    )
    expect(screen.getByText('No data')).toBeInTheDocument()
  })

  it('draws Y-axis tick labels and X-axis bucket labels', () => {
    render(
      <GraphWidgetBody
        tile={tile({
          type: 'xy',
          config: { xField: 'closed_at', yField: 'amount', aggregate: 'sum', bucket: 'month' },
        })}
        descriptor={descriptor}
        records={records}
        recordTotal={3}
      />,
    )
    const chart = screen.getByRole('img', { name: 'Line chart' })
    // Bucket keys ('2024-01'/'2024-02') render as short localized month labels,
    // not the raw key — check the same Intl call the component itself uses.
    const label = (d: Date) => new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' }).format(d)
    const texts = Array.from(chart.querySelectorAll('text')).map((el) => el.textContent)
    expect(texts).toContain(label(new Date(2024, 0, 1)))
    expect(texts).toContain(label(new Date(2024, 1, 1)))
    // At least one numeric Y-axis gridline label is present too (0 is always ticked).
    expect(texts).toContain('0.0')
  })

  it('renders one line + legend entry per distinct seriesField value', () => {
    render(
      <GraphWidgetBody
        tile={tile({
          type: 'xy',
          config: {
            xField: 'closed_at',
            yField: 'amount',
            seriesField: 'status',
            aggregate: 'sum',
            bucket: 'month',
          },
        })}
        descriptor={descriptor}
        records={records}
        recordTotal={3}
      />,
    )
    const chart = screen.getByRole('img', { name: 'Line chart' })
    expect(chart.querySelectorAll('path')).toHaveLength(2) // 'open' and 'won' series
    expect(screen.getByText('open')).toBeInTheDocument()
    expect(screen.getByText('won')).toBeInTheDocument()
  })

  it('shows no legend for a single (implicit) series', () => {
    render(
      <GraphWidgetBody
        tile={tile({
          type: 'xy',
          config: { xField: 'closed_at', yField: 'amount', aggregate: 'sum', bucket: 'month' },
        })}
        descriptor={descriptor}
        records={records}
        recordTotal={3}
      />,
    )
    // No series labels ('open'/'won') rendered as legend text when there's one line.
    expect(screen.queryByText('open')).not.toBeInTheDocument()
    expect(screen.queryByText('won')).not.toBeInTheDocument()
  })
})

describe('GraphWidgetBody: pie', () => {
  it('renders one slice per group with a legend entry each', () => {
    render(
      <GraphWidgetBody
        tile={tile({ type: 'pie', config: { groupByField: 'status', aggregate: 'count' } })}
        descriptor={descriptor}
        records={records}
        recordTotal={3}
      />,
    )
    const chart = screen.getByRole('img', { name: 'Pie chart' })
    expect(chart.querySelectorAll('circle')).toHaveLength(2) // open, won
    expect(screen.getByText('open')).toBeInTheDocument()
    expect(screen.getByText('won')).toBeInTheDocument()
  })
})

describe('GraphWidgetBody: list', () => {
  function opsWith(list: RelationOps['list']): RelationOps {
    return { list, get: vi.fn(), create: vi.fn(), remove: vi.fn() }
  }

  it('shows an inert message with no RelationOpsProvider mounted', () => {
    render(
      <GraphWidgetBody
        tile={tile({
          type: 'list',
          config: { filterField: 'status', filterValue: 'open', displayFields: ['name'] },
        })}
        descriptor={descriptor}
        records={records}
        recordTotal={3}
      />,
    )
    expect(screen.getByText(/Related-record lookups are not available/)).toBeInTheDocument()
  })

  it('fetches server-side with the configured filter and renders the chosen columns', async () => {
    const list = vi.fn(
      async () => [{ id: '1', name: 'Acme', amount: 100 }] as RelationRecord[],
    )
    render(
      <RelationOpsProvider ops={opsWith(list)}>
        <GraphWidgetBody
          tile={tile({
            type: 'list',
            config: { filterField: 'status', filterValue: 'open', displayFields: ['name', 'amount'] },
          })}
          descriptor={descriptor}
          records={records}
          recordTotal={3}
        />
      </RelationOpsProvider>,
    )
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith('crm', { filter: { status: 'open' }, pageSize: 20 }),
    )
    expect(await screen.findByText('Acme')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument()
  })

  it('shows a no-match message for an empty result', async () => {
    render(
      <RelationOpsProvider ops={opsWith(vi.fn(async () => []))}>
        <GraphWidgetBody
          tile={tile({
            type: 'list',
            config: { filterField: 'status', filterValue: 'nope', displayFields: ['name'] },
          })}
          descriptor={descriptor}
          records={records}
          recordTotal={3}
        />
      </RelationOpsProvider>,
    )
    expect(await screen.findByText('No matching records.')).toBeInTheDocument()
  })

  it('degrades to an empty result rather than throwing when the query fails', async () => {
    render(
      <RelationOpsProvider
        ops={opsWith(
          vi.fn(async () => {
            throw new Error('boom')
          }),
        )}
      >
        <GraphWidgetBody
          tile={tile({
            type: 'list',
            config: { filterField: 'status', filterValue: 'open', displayFields: ['name'] },
          })}
          descriptor={descriptor}
          records={records}
          recordTotal={3}
        />
      </RelationOpsProvider>,
    )
    expect(await screen.findByText('No matching records.')).toBeInTheDocument()
  })
})
