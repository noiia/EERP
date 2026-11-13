import { describe, expect, it } from 'vitest'
import type { ViewDescriptor } from './descriptor'
import { orderedFields, orderLabel } from './layout-fields'

interface Deal {
  id: string
  name: string
  status: string
  amount: number
  notes: string
}

const descriptor: ViewDescriptor<Deal> = {
  entity: 'deals',
  viewType: 'tree',
  fields: [
    { name: 'name', label: 'Name', type: 'text' },
    { name: 'status', label: 'Status', type: 'selection', selection: { options: ['open'] } },
    { name: 'amount', label: 'Amount', type: 'number' },
    { name: 'notes', label: 'Notes', type: 'text' },
  ],
}

describe('orderedFields', () => {
  it('returns every field in normalized layout order by default', () => {
    expect(orderedFields(descriptor).map((f) => f.name)).toEqual(['name', 'status', 'amount', 'notes'])
  })

  it('excludes named fields', () => {
    expect(orderedFields(descriptor, { exclude: ['status'] }).map((f) => f.name)).toEqual([
      'name',
      'amount',
      'notes',
    ])
  })

  it('skips geo and distance fields, which have no text form', () => {
    const d: ViewDescriptor<{ id: string }> = {
      entity: 'x',
      viewType: 'tree',
      fields: [
        { name: 'geo_location', type: 'geo' },
        { name: 'name', type: 'text' },
        { name: 'distance', type: 'distance' },
      ],
    }
    expect(orderedFields(d).map((f) => f.name)).toEqual(['name'])
  })

  it('caps the result at limit', () => {
    expect(orderedFields(descriptor, { exclude: ['status'], limit: 2 }).map((f) => f.name)).toEqual([
      'name',
      'amount',
    ])
  })

  it('limit: 1 gives just the natural label field', () => {
    expect(orderedFields(descriptor, { exclude: ['status'], limit: 1 }).map((f) => f.name)).toEqual(['name'])
  })
})

describe('orderLabel', () => {
  const ordered = { ...descriptor, viewModeDefaults: { wbsOrderField: 'notes' } } as ViewDescriptor<Deal>
  it('shows the order field as "<order> - <name>", the name alone while unnumbered', () => {
    expect(orderLabel(ordered, 'notes', { id: '1', notes: '1.2', name: 'Design' })).toBe('1.2 - Design')
    expect(orderLabel(ordered, 'notes', { id: '1', notes: '', name: 'Design' })).toBe('Design')
    expect(orderLabel(ordered, 'notes', { id: '1', notes: '3', title: 'Plan' })).toBe('3 - Plan')
    expect(orderLabel(ordered, 'notes', { id: '1', notes: '3' })).toBe('3')
  })
  it('is null for any other field, or without an order field', () => {
    expect(orderLabel(ordered, 'name', { id: '1', notes: '1', name: 'x' })).toBeNull()
    expect(orderLabel(descriptor, 'notes', { id: '1', notes: '1', name: 'x' })).toBeNull()
  })
})
