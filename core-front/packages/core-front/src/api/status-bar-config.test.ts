import { describe, expect, it } from 'vitest'
import type { ViewDescriptor } from '../views/descriptor'
import { resolveStatusBar } from './status-bar-config'

const descriptor: ViewDescriptor = {
  entity: 'crm',
  viewType: 'form',
  fields: [
    { name: 'name', label: 'Name', type: 'text' },
    { name: 'status', label: 'Status', type: 'selection', selection: { options: ['incoming', 'running', 'won', 'lost'] } },
    { name: 'stage', label: 'Stage', type: 'selection', selection: { options: ['cold', 'hot'] } },
  ],
  statusBar: { field: 'status' },
}

describe('resolveStatusBar', () => {
  it('defaults to the module field and every one of its options', () => {
    const got = resolveStatusBar(descriptor)
    expect(got?.field.name).toBe('status')
    expect(got?.steps).toEqual(['incoming', 'running', 'won', 'lost'])
  })

  it('is null when the form declares no breadcrumb, whatever the override says', () => {
    expect(resolveStatusBar({ ...descriptor, statusBar: undefined }, { field: 'status', steps: null })).toBeNull()
  })

  it.each([
    ['another selection field', { field: 'stage', steps: null }, 'stage', ['cold', 'hot']],
    ['a subset, in its own order', { field: null, steps: ['won', 'incoming'] }, 'status', ['won', 'incoming']],
    ['unknown steps dropped', { field: null, steps: ['won', 'gone'] }, 'status', ['won']],
    ['no usable step falls back to every option', { field: null, steps: ['gone'] }, 'status', ['incoming', 'running', 'won', 'lost']],
    ['a field the form lacks falls back to the module field', { field: 'nope', steps: ['won'] }, 'status', ['incoming', 'running', 'won', 'lost']],
    ['a non-selection field falls back', { field: 'name', steps: null }, 'status', ['incoming', 'running', 'won', 'lost']],
    ['duplicate steps kept once', { field: 'status', steps: ['won', 'won'] }, 'status', ['won']],
  ])('override: %s', (_, config, field, steps) => {
    const got = resolveStatusBar(descriptor, config)
    expect(got?.field.name).toBe(field)
    expect(got?.steps).toEqual(steps)
  })
})
