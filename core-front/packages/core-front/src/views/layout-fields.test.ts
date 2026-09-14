import { describe, expect, it } from 'vitest'
import type { ViewDescriptor } from './descriptor'
import { orderedFields } from './layout-fields'

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
