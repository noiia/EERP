import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { moduleRegistry } from '../registry'
import type { FieldDescriptor } from './descriptor'
import { RelationOpsProvider, type RelationOps, type RelationRecord } from './relation-ops'
import { fieldWidget } from './widgets'

// relation/summary: a many2one field rendered as a read-only one-row recap
// instead of the stock search+wizard widget.

const summaryField: FieldDescriptor = {
  name: 'property_management_id',
  label: 'Property',
  type: 'relation',
  widget: 'summary',
  widgetOptions: {
    fields: ['name', 'city'],
    relatedRelationField: 'current_tenant',
    relatedRelationLabel: 'Tenant',
  },
  relation: { entity: 'property_management', kind: 'many2one' },
}

function stubOps(overrides: Partial<RelationOps> = {}): RelationOps {
  return {
    list: vi.fn(async () => [] as RelationRecord[]),
    get: vi.fn(async (_entity: string, id: string) => ({ id, name: 'Sunset Apartments', city: 'Springfield' })),
    create: vi.fn(),
    remove: vi.fn(),
    ...overrides,
  }
}

function renderWidget(ops: RelationOps, value: unknown) {
  const Widget = fieldWidget(summaryField)
  render(
    <RelationOpsProvider ops={ops}>
      <Widget field={summaryField} value={value} onChange={vi.fn()} entity="property_management_equipment" recordId="eq1" />
    </RelationOpsProvider>,
  )
}

describe('relation/summary', () => {
  it('renders "Not linked." when the FK is unset', () => {
    renderWidget(stubOps(), null)
    expect(screen.getByText('Not linked.')).toBeInTheDocument()
  })

  it('fetches and shows the declared scalar fields', async () => {
    const ops = stubOps()
    renderWidget(ops, 'prop1')
    await waitFor(() => expect(ops.get).toHaveBeenCalledWith('property_management', 'prop1'))
    expect(await screen.findByText('Sunset Apartments')).toBeInTheDocument()
    expect(screen.getByText('Springfield')).toBeInTheDocument()
  })

  it('shows the base fields with an empty joined column when the related entity has no registered descriptor', async () => {
    const ops = stubOps()
    renderWidget(ops, 'prop1')
    const row = (await screen.findByText('Sunset Apartments')).closest('tr')!
    // No crash, no extra fetch attempted for the sub-relation.
    expect(within(row).getByRole('cell', { name: '' })).toBeInTheDocument()
  })

  it('resolves a many2many relatedRelationField (declared on the related entity\'s OWN registered descriptor) and joins its labels', async () => {
    moduleRegistry.register({
      name: 'summary-widget-test-fixture',
      routes: [
        {
          path: '/__test__/property_management/:id',
          descriptor: {
            entity: 'property_management',
            viewType: 'form',
            fields: [
              { name: 'name', type: 'text' },
              {
                name: 'current_tenant',
                type: 'relation',
                relation: { entity: 'contact', kind: 'many2many', via: 'property_management_tenant' },
              },
            ],
          },
        },
      ],
    })

    const junctions: RelationRecord[] = [
      { id: 'j1', property_management_id: 'prop1', contact_id: 'c1' },
      { id: 'j2', property_management_id: 'prop1', contact_id: 'c2' },
    ]
    const contacts: Record<string, RelationRecord> = {
      c1: { id: 'c1', name: 'Ada Lovelace' },
      c2: { id: 'c2', name: 'Grace Hopper' },
    }
    const ops = stubOps({
      get: vi.fn(async (entity: string, id: string) =>
        entity === 'property_management' ? { id, name: 'Sunset Apartments', city: 'Springfield' } : contacts[id],
      ),
      list: vi.fn(async (entity: string) => (entity === 'property_management_tenant' ? junctions : [])),
    })
    renderWidget(ops, 'prop1')

    expect(await screen.findByText('Ada Lovelace, Grace Hopper')).toBeInTheDocument()
    expect(screen.getByText('Tenant')).toBeInTheDocument()
  })
})
