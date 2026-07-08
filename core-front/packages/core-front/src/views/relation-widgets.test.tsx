import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { EntityListOptions } from '../api/list-options'
import type { FieldDescriptor } from './descriptor'
import { RelationOpsProvider, type RelationOps, type RelationRecord } from './relation-ops'
import { fieldWidget, type WidgetProps } from './widgets'

// Relation widgets against stubbed RelationOps (the bound Server Actions the
// host provides): search set/unset, wizard select round-trip, tags add/remove
// over junction fixtures, o2m scoped rows.

const companies: RelationRecord[] = [
  { id: 'c1', name: 'Acme', status: 'customer' },
  { id: 'c2', name: 'Globex', status: 'lead' },
]

function stubOps(overrides: Partial<RelationOps> = {}): RelationOps {
  return {
    list: vi.fn(async () => companies),
    get: vi.fn(async (_entity: string, id: string) => companies.find((c) => c.id === id) ?? { id }),
    create: vi.fn(async (_entity: string, body: Record<string, unknown>) => ({ id: 'j-new', ...body })),
    remove: vi.fn(async () => undefined),
    ...overrides,
  }
}

function Harness({
  field,
  ops,
  onChange,
  initialValue,
  recordId,
}: {
  field: FieldDescriptor
  ops: RelationOps
  onChange: (next: unknown) => void
  initialValue: unknown
  recordId: string | null
}) {
  const [value, setValue] = useState<unknown>(initialValue)
  const Widget = fieldWidget(field)
  return (
    <RelationOpsProvider ops={ops}>
      <Widget
        field={field}
        value={value}
        onChange={(next) => {
          onChange(next)
          setValue(next)
        }}
        entity="crm"
        recordId={recordId}
      />
    </RelationOpsProvider>
  )
}

function renderWidget(
  field: FieldDescriptor,
  ops: RelationOps,
  props: Partial<WidgetProps> = {},
) {
  const onChange = vi.fn()
  render(
    <Harness
      field={field}
      ops={ops}
      onChange={onChange}
      initialValue={props.value ?? null}
      recordId={props.recordId !== undefined ? props.recordId : 'r1'}
    />,
  )
  return { onChange }
}

const searchField: FieldDescriptor = {
  name: 'contact_id',
  label: 'Company',
  type: 'relation',
  relation: { entity: 'contact', kind: 'many2one', labelField: 'name' },
}

const tagsField: FieldDescriptor = {
  name: 'tags',
  label: 'Tags',
  type: 'relation',
  relation: { entity: 'tag', kind: 'many2many', via: 'crm_tag', labelField: 'name' },
}

const listField: FieldDescriptor = {
  name: 'crm_records',
  label: 'CRM records',
  type: 'relation',
  relation: { entity: 'crm', kind: 'one2many', inverseField: 'contact_id', labelField: 'name' },
}

describe('relation/search (many2one)', () => {
  it('searches the related entity and sets the FK on pick', async () => {
    const ops = stubOps()
    const { onChange } = renderWidget(searchField, ops)

    const input = screen.getByRole('combobox')
    fireEvent.click(input)
    fireEvent.change(input, { target: { value: 'ac' } })

    // Debounced server-side search (Go authorizes; no client re-filtering).
    await waitFor(() =>
      expect(ops.list).toHaveBeenCalledWith('contact', {
        search: { name: 'ac' },
        pageSize: 10,
      }),
    )
    fireEvent.click(await screen.findByText('Acme'))
    expect(onChange).toHaveBeenCalledWith('c1')
    // The picked record renders as a tag.
    expect(await screen.findByText('Acme')).toBeInTheDocument()
  })

  it('renders the current FK as a tag and unlinks to null from its cross', async () => {
    const ops = stubOps()
    const { onChange } = renderWidget(searchField, ops, { value: 'c2' })

    // Label resolved through ops.get (the value is only the FK).
    expect(await screen.findByText('Globex')).toBeInTheDocument()
    expect(ops.get).toHaveBeenCalledWith('contact', 'c2')

    const tag = screen.getByText('Globex').closest('.MuiChip-root')!
    fireEvent.click(tag.querySelector('.MuiChip-deleteIcon')!)
    expect(onChange).toHaveBeenCalledWith(null)
    // Unlinked: back to the search input.
    expect(await screen.findByRole('combobox')).toBeInTheDocument()
  })

  it('wizard: opens from the link icon, picking a row sets the value', async () => {
    const ops = stubOps()
    const { onChange } = renderWidget(searchField, ops)

    fireEvent.click(screen.getByRole('button', { name: 'Open selection wizard' }))
    expect(await screen.findByText('Select a record')).toBeInTheDocument()

    // The grid lists the related records; row click = select.
    fireEvent.click(await screen.findByText('Globex'))
    expect(onChange).toHaveBeenCalledWith('c2')
    await waitFor(() => expect(screen.queryByText('Select a record')).not.toBeInTheDocument())
  })
})

describe('relation/tags (many2many)', () => {
  const junctions: RelationRecord[] = [
    { id: 'j1', crm_id: 'r1', tag_id: 'c1' },
    { id: 'j2', crm_id: 'r1', tag_id: 'c2' },
  ]

  it('loads junction rows as tags and unlinks by deleting the junction row', async () => {
    const ops = stubOps({
      list: vi.fn(async (entity: string, _o?: EntityListOptions) =>
        entity === 'crm_tag' ? junctions : companies,
      ),
    })
    renderWidget(tagsField, ops)

    expect(await screen.findByText('Acme')).toBeInTheDocument()
    expect(await screen.findByText('Globex')).toBeInTheDocument()
    // Junction read is scoped to this record via the convention columns.
    expect(ops.list).toHaveBeenCalledWith('crm_tag', {
      filter: { crm_id: 'r1' },
      pageSize: 100,
    })

    const tag = screen.getByText('Acme').closest('.MuiChip-root')!
    fireEvent.click(tag.querySelector('.MuiChip-deleteIcon')!)
    await waitFor(() => expect(ops.remove).toHaveBeenCalledWith('crm_tag', 'j1'))
    await waitFor(() => expect(screen.queryByText('Acme')).not.toBeInTheDocument())
  })

  it('adds a link by creating a junction row from the search input', async () => {
    const ops = stubOps({
      list: vi.fn(async (entity: string, _o?: EntityListOptions) =>
        entity === 'crm_tag' ? [] : companies,
      ),
    })
    renderWidget(tagsField, ops)

    const input = screen.getByRole('combobox')
    fireEvent.click(input)
    fireEvent.change(input, { target: { value: 'glo' } })
    fireEvent.click(await screen.findByText('Globex'))

    await waitFor(() =>
      expect(ops.create).toHaveBeenCalledWith('crm_tag', { crm_id: 'r1', tag_id: 'c2' }),
    )
    // The new link renders as a tag.
    expect(await screen.findByText('Globex')).toBeInTheDocument()
  })

  it('shows a hint before the record exists', () => {
    renderWidget(tagsField, stubOps(), { recordId: null })
    expect(screen.getByText('Available once the record has been saved.')).toBeInTheDocument()
  })
})

describe('relation/list (one2many)', () => {
  it('embeds the inverse records, scoped by the inverse FK', async () => {
    const ops = stubOps()
    renderWidget(listField, ops)

    await waitFor(() =>
      expect(ops.list).toHaveBeenCalledWith('crm', {
        filter: { contact_id: 'r1' },
        pageSize: 100,
      }),
    )
    expect(await screen.findByText('Acme')).toBeInTheDocument()
    expect(await screen.findByText('Globex')).toBeInTheDocument()
  })

  it('shows a hint before the record exists', () => {
    renderWidget(listField, stubOps(), { recordId: null })
    expect(screen.getByText('Available once the record has been saved.')).toBeInTheDocument()
  })
})
