import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { Tile } from '../api/graph'
import { planTile, useServerTileData } from './graph-server'
import type { GraphOps } from './graph-ops'

const calcFields = [
  { id: '1', key: 'calc_tax', label: 'Tax', formula: 'total - subtotal', roles: [] },
  { id: '2', key: 'calc_dated', label: 'Dated', formula: 'rent_price', roles: [], dated: true },
]
const isNumber = (f: string) => ['total', 'subtotal', 'deals'].includes(f) || f.startsWith('calc_')
const labelOf = (f: string) => f.toUpperCase()
const tile = (type: Tile['type'], config: Record<string, unknown>): Tile => ({ id: 't', x: 0, y: 0, w: 6, h: 6, type, config: config as Tile['config'] })

describe('planTile', () => {
  it('stat: a count counts rows; other aggregates send the (expanded) field', () => {
    expect(planTile(tile('stat', { field: 'id', aggregate: 'count' }), calcFields, isNumber, labelOf)!.requests).toEqual([
      { aggregate: 'count' },
    ])
    const plan = planTile(tile('stat', { field: 'calc_tax', aggregate: 'median' }), calcFields, isNumber, labelOf)!
    expect(plan.requests).toEqual([{ aggregate: 'median', value: 'total - subtotal' }])
    expect(plan.assemble([[{ value: 42, count: 3 }]])).toEqual({ stat: 42 })
    expect(plan.assemble([[]])).toEqual({ stat: 0 })
  })

  it('xy with a series field: one grouped request', () => {
    const plan = planTile(
      tile('xy', { xField: 'issue_date', yField: 'total', aggregate: 'sum', bucket: 'month', seriesField: 'status' }),
      calcFields,
      isNumber,
      labelOf,
    )!
    expect(plan.requests).toEqual([{ aggregate: 'sum', value: 'total', x: 'issue_date', bucket: 'month', group: 'status' }])
    expect(plan.assemble([[{ x: '2026-01', group: 'paid', value: 5, count: 1 }]])).toEqual({
      series: [{ label: 'paid', points: [{ bucket: '2026-01', value: 5 }] }],
    })
  })

  it('xy with several y fields: one request per field, labelled', () => {
    const plan = planTile(
      tile('xy', { xField: 'issue_date', yField: 'total', yFields: ['total', 'calc_tax'], aggregate: 'sum', bucket: 'week' }),
      calcFields,
      isNumber,
      labelOf,
    )!
    expect(plan.requests.map((r) => r.value)).toEqual(['total', 'total - subtotal'])
    expect(plan.assemble([[{ x: '2026-01-05', value: 1, count: 1 }], []])).toEqual({
      series: [
        { label: 'TOTAL', points: [{ bucket: '2026-01-05', value: 1 }] },
        { label: 'CALC_TAX', points: [] },
      ],
    })
  })

  it('bar count over a non-numeric y counts rows', () => {
    const plan = planTile(tile('bar', { xField: 'created_at', yField: 'id', aggregate: 'count', bucket: 'month' }), calcFields, isNumber, labelOf)!
    expect(plan.requests).toEqual([{ aggregate: 'count', value: undefined, x: 'created_at', bucket: 'month', group: undefined }])
  })

  it('pie: count by group, or sum of the value field', () => {
    expect(planTile(tile('pie', { groupByField: 'status' }), calcFields, isNumber, labelOf)!.requests).toEqual([
      { aggregate: 'count', group: 'status' },
    ])
    const plan = planTile(tile('pie', { groupByField: 'status', valueField: 'deals' }), calcFields, isNumber, labelOf)!
    expect(plan.requests).toEqual([{ aggregate: 'sum', value: 'deals', group: 'status' }])
    expect(plan.assemble([[{ group: 'won', value: 9, count: 2 }]])).toEqual({ slices: [{ label: 'won', count: 2, displayValue: 9 }] })
  })

  it('stays client-side for list tiles, incomplete configs and dated calc fields', () => {
    expect(planTile(tile('list', { filterField: 'status', filterValue: 'x' }), calcFields, isNumber, labelOf)).toBeNull()
    expect(planTile(tile('xy', { xField: 'issue_date' }), calcFields, isNumber, labelOf)).toBeNull()
    expect(planTile(tile('stat', { field: 'calc_dated', aggregate: 'sum' }), calcFields, isNumber, labelOf)).toBeNull()
  })
})

describe('useServerTileData', () => {
  const plan = planTile(tile('stat', { field: 'total', aggregate: 'sum' }), calcFields, isNumber, labelOf)

  it('is loading, then the assembled data, with the list filters forwarded', async () => {
    const aggregate = vi.fn(async () => [{ value: 7, count: 1 }])
    const ops = { aggregate } as unknown as GraphOps
    const { result } = renderHook(() => useServerTileData('invoice', plan, ops, { filter: { status: 'paid' } }))
    expect(result.current).toBe('loading')
    await waitFor(() => expect(result.current).toEqual({ stat: 7 }))
    expect(aggregate).toHaveBeenCalledWith('invoice', { aggregate: 'sum', value: 'total' }, { filter: { status: 'paid' } })
  })

  it('falls back to the client path (undefined) when the host has no aggregate or a call fails', async () => {
    expect(renderHook(() => useServerTileData('invoice', plan, {} as GraphOps, undefined)).result.current).toBeUndefined()
    const ops = { aggregate: vi.fn(async () => null) } as unknown as GraphOps
    const { result } = renderHook(() => useServerTileData('invoice', plan, ops, undefined))
    await waitFor(() => expect(result.current).toBeUndefined())
  })
})
