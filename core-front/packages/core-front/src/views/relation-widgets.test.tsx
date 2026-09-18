import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import Typography from '@mui/material/Typography'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

// RelationListWidget navigates via the App Router when relation.formPath is declared.
const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

import type { FieldDescriptor, ViewDescriptor } from './descriptor'
import { moduleRegistry } from '../registry'
import { RelationOpsProvider, type RelationOps, type RelationRecord } from './relation-ops'
import { useHasLinksStore } from './required-relation-store'
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
  onChangeField,
  initialValue,
  recordId,
}: {
  field: FieldDescriptor
  ops: RelationOps
  onChange: (next: unknown) => void
  onChangeField: (name: string, value: unknown) => void
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
        onChangeField={onChangeField}
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
  const onChangeField = vi.fn()
  render(
    <Harness
      field={field}
      ops={ops}
      onChange={onChange}
      onChangeField={onChangeField}
      initialValue={props.value ?? null}
      recordId={props.recordId !== undefined ? props.recordId : 'r1'}
    />,
  )
  return { onChange, onChangeField }
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
    // 6 result rows — the create line is the dropdown's 7th entry.
    await waitFor(() =>
      expect(ops.list).toHaveBeenCalledWith('contact', {
        search: { name: 'ac' },
        pageSize: 6,
      }),
    )
    fireEvent.click(await screen.findByText('Acme'))
    expect(onChange).toHaveBeenCalledWith('c1')
    // The picked record renders as a tag.
    expect(await screen.findByText('Acme')).toBeInTheDocument()
  })

  it('widgetOptions.fillFields: picking a record patches sibling fields via onChangeField (e.g. sale\'s customer_id -> customer_name/email)', async () => {
    const ops = stubOps()
    const { onChange, onChangeField } = renderWidget(
      { ...searchField, widgetOptions: { fillFields: { name: 'customer_name', status: 'customer_status' } } },
      ops,
    )

    const input = screen.getByRole('combobox')
    fireEvent.click(input)
    fireEvent.change(input, { target: { value: 'ac' } })
    fireEvent.click(await screen.findByText('Acme'))

    expect(onChange).toHaveBeenCalledWith('c1')
    // Both mapped columns come straight off the ALREADY-loaded search result
    // (companies' own 'Acme' row) — no second fetch.
    expect(onChangeField).toHaveBeenCalledWith('customer_name', 'Acme')
    expect(onChangeField).toHaveBeenCalledWith('customer_status', 'customer')
  })

  it('with no widgetOptions.fillFields declared, picking a record never touches onChangeField', async () => {
    const ops = stubOps()
    const { onChangeField } = renderWidget(searchField, ops)

    const input = screen.getByRole('combobox')
    fireEvent.click(input)
    fireEvent.change(input, { target: { value: 'ac' } })
    fireEvent.click(await screen.findByText('Acme'))

    expect(onChangeField).not.toHaveBeenCalled()
  })

  it('excludes the current record\'s own id from the results — by design, no per-field opt-in', async () => {
    const ops = stubOps()
    renderWidget(searchField, ops, { recordId: 'c1' })

    const input = screen.getByRole('combobox')
    fireEvent.click(input)
    fireEvent.change(input, { target: { value: 'a' } })

    await waitFor(() => expect(ops.list).toHaveBeenCalled())
    expect(await screen.findByText('Globex')).toBeInTheDocument()
    expect(screen.queryByText('Acme')).not.toBeInTheDocument()
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

  it('create-from-search: the last option creates the record and sets the FK', async () => {
    const created = { id: 'c-new', name: 'Initech' }
    const ops = stubOps({ create: vi.fn(async () => created) })
    const { onChange } = renderWidget(searchField, ops)

    const input = screen.getByRole('combobox')
    fireEvent.click(input)
    fireEvent.change(input, { target: { value: 'Initech' } })

    // The 7th line, under the (up to 6) result rows.
    fireEvent.click(await screen.findByText('Create a new Contact'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Create a new Contact')

    // No form view is registered for 'contact' here → the labelField fallback
    // form, prefilled with the typed search text.
    const nameInput = within(dialog).getByDisplayValue('Initech')
    fireEvent.change(nameInput, { target: { value: 'Initech Ltd' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(ops.create).toHaveBeenCalledWith('contact', expect.objectContaining({ name: 'Initech Ltd' })),
    )
    // The new record becomes the FK, exactly like a pick.
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('c-new'))
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

  it('hideLabel: true suppresses the caption but the search input still works', async () => {
    const ops = stubOps()
    renderWidget({ ...searchField, hideLabel: true }, ops)
    expect(screen.queryByText('Company')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })

  describe('relation.filter — static server-side scope (e.g. propertymanagement\'s uom_id: surface only)', () => {
    const scopedField: FieldDescriptor = {
      ...searchField,
      relation: { ...searchField.relation!, filter: { type: 'surface' } },
    }

    it('applies the filter to the dropdown\'s search read', async () => {
      const ops = stubOps()
      renderWidget(scopedField, ops)

      const input = screen.getByRole('combobox')
      fireEvent.click(input)
      fireEvent.change(input, { target: { value: 'ac' } })
      await waitFor(() =>
        expect(ops.list).toHaveBeenCalledWith(
          'contact',
          expect.objectContaining({ filter: { type: 'surface' } }),
        ),
      )
    })

    it('applies the filter to the link-icon wizard\'s own grid read', async () => {
      const ops = stubOps()
      renderWidget(scopedField, ops)

      fireEvent.click(screen.getByRole('button', { name: 'Open selection wizard' }))
      await waitFor(() =>
        expect(ops.list).toHaveBeenCalledWith(
          'contact',
          expect.objectContaining({ filter: { type: 'surface' } }),
        ),
      )
    })

    it('with no relation.filter declared, filter is omitted — unchanged for every existing many2one', async () => {
      const ops = stubOps()
      renderWidget(searchField, ops)

      const input = screen.getByRole('combobox')
      fireEvent.click(input)
      fireEvent.change(input, { target: { value: 'ac' } })
      await waitFor(() => expect(ops.list).toHaveBeenCalled())
      const [, options] = vi.mocked(ops.list).mock.calls[0]
      expect(options?.filter).toBeUndefined()
    })
  })

  describe('click-to-navigate', () => {
    beforeEach(() => {
      pushMock.mockClear()
      // moduleRegistry.formPathFor('contact') — resolved off the target
      // entity's own registered LIST view, same lookup FormListNav uses
      // (renderers.test.tsx's 'form record navigator' describe block).
      moduleRegistry.register({
        name: 'contact-nav-test-fixture',
        routes: [
          {
            path: '/contact/list',
            descriptor: { entity: 'contact', viewType: 'tree', fields: [], formPath: '/contact/:id' },
          },
        ],
      })
    })

    it('clicking the tag label navigates to the linked record\'s own form', async () => {
      const ops = stubOps()
      renderWidget(searchField, ops, { value: 'c2' })
      fireEvent.click(await screen.findByText('Globex'))
      expect(pushMock).toHaveBeenCalledWith('/contact/c2')
    })

    it('clicking the unlink cross unlinks instead of navigating', async () => {
      const ops = stubOps()
      const { onChange } = renderWidget(searchField, ops, { value: 'c2' })
      const tag = (await screen.findByText('Globex')).closest('.MuiChip-root')!
      fireEvent.click(tag.querySelector('.MuiChip-deleteIcon')!)
      expect(onChange).toHaveBeenCalledWith(null)
      expect(pushMock).not.toHaveBeenCalled()
    })
  })
})

describe('relation/tags (many2many)', () => {
  const junctions: RelationRecord[] = [
    { id: 'j1', crm_id: 'r1', tag_id: 'c1' },
    { id: 'j2', crm_id: 'r1', tag_id: 'c2' },
  ]

  it('excludes the current record\'s own id from the dropdown options — by design, no per-field opt-in', async () => {
    const ops = stubOps({
      list: vi.fn(async (entity: string) => (entity === 'crm_tag' ? [] : companies)),
    })
    renderWidget(tagsField, ops, { recordId: 'c1' })

    const input = screen.getByRole('combobox')
    fireEvent.click(input)
    fireEvent.change(input, { target: { value: 'a' } })

    await waitFor(() => expect(ops.list).toHaveBeenCalledWith('tag', expect.anything()))
    expect(await screen.findByText('Globex')).toBeInTheDocument()
    expect(screen.queryByText('Acme')).not.toBeInTheDocument()
  })

  it('loads junction rows as tags and unlinks by deleting the junction row', async () => {
    const ops = stubOps({
      list: vi.fn(async (entity: string) =>
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
      list: vi.fn(async (entity: string) =>
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

  it('create-from-search: the last option creates the tag AND its junction row', async () => {
    const create = vi.fn(async (entity: string, body: Record<string, unknown>) =>
      entity === 'tag' ? { id: 't-new', ...body } : { id: 'j-new', ...body },
    )
    const ops = stubOps({
      list: vi.fn(async (entity: string) =>
        entity === 'crm_tag' ? [] : companies,
      ),
      create,
    })
    renderWidget(tagsField, ops)

    const input = screen.getByRole('combobox')
    fireEvent.click(input)
    fireEvent.change(input, { target: { value: 'vip' } })
    fireEvent.click(await screen.findByText('Create a new Tag'))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    // First the tag itself (labelField prefilled with the typed text), then the
    // junction row linking it to this record.
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith('tag', expect.objectContaining({ name: 'vip' })),
    )
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith('crm_tag', { crm_id: 'r1', tag_id: 't-new' }),
    )
    expect(await screen.findByText('vip')).toBeInTheDocument()
  })

  it('shows a hint before the record exists', () => {
    renderWidget(tagsField, stubOps(), { recordId: null })
    expect(screen.getByText('Available once the record has been saved.')).toBeInTheDocument()
  })

  it('resolves every linked tag in ONE batched list call, never one get() per row (was N+1)', async () => {
    const listMock = vi.fn(async (entity: string) => (entity === 'crm_tag' ? junctions : companies))
    const ops = stubOps({ list: listMock })
    renderWidget(tagsField, ops)

    expect(await screen.findByText('Acme')).toBeInTheDocument()
    expect(await screen.findByText('Globex')).toBeInTheDocument()
    // Exactly two calls total: junctions, then the batched related lookup —
    // regardless of how many rows were linked.
    expect(listMock).toHaveBeenCalledTimes(2)
    expect(listMock).toHaveBeenCalledWith('tag', { in: { id: ['c1', 'c2'] }, pageSize: 100 })
    expect(ops.get).not.toHaveBeenCalled()
  })

  it('a dangling junction (related record deleted) keeps the id as its own placeholder', async () => {
    const danglingJunctions: RelationRecord[] = [
      { id: 'j1', crm_id: 'r1', tag_id: 'c1' },
      { id: 'j2', crm_id: 'r1', tag_id: 'missing' },
    ]
    const ops = stubOps({
      list: vi.fn(async (entity: string) => (entity === 'crm_tag' ? danglingJunctions : companies)),
    })
    renderWidget(tagsField, ops)

    expect(await screen.findByText('Acme')).toBeInTheDocument()
    expect(await screen.findByText('missing')).toBeInTheDocument()
  })

  it('hideLabel: true suppresses the caption but tags still render', async () => {
    const ops = stubOps({
      list: vi.fn(async (entity: string) => (entity === 'crm_tag' ? junctions : companies)),
    })
    renderWidget({ ...tagsField, hideLabel: true }, ops)
    expect(screen.queryByText('Tags')).not.toBeInTheDocument()
    expect(await screen.findByText('Acme')).toBeInTheDocument()
  })

  describe('click-to-navigate', () => {
    beforeEach(() => {
      pushMock.mockClear()
      moduleRegistry.register({
        name: 'tag-nav-test-fixture',
        routes: [
          {
            path: '/tag/list',
            descriptor: { entity: 'tag', viewType: 'tree', fields: [], formPath: '/tag/:id' },
          },
        ],
      })
    })

    it('clicking a tag\'s label navigates to its linked record\'s own form', async () => {
      const ops = stubOps({
        list: vi.fn(async (entity: string) => (entity === 'crm_tag' ? junctions : companies)),
      })
      renderWidget(tagsField, ops)
      fireEvent.click(await screen.findByText('Acme'))
      expect(pushMock).toHaveBeenCalledWith('/tag/c1')
    })

    it('clicking the unlink cross unlinks instead of navigating', async () => {
      const ops = stubOps({
        list: vi.fn(async (entity: string) => (entity === 'crm_tag' ? junctions : companies)),
      })
      renderWidget(tagsField, ops)
      const tag = (await screen.findByText('Acme')).closest('.MuiChip-root')!
      fireEvent.click(tag.querySelector('.MuiChip-deleteIcon')!)
      await waitFor(() => expect(ops.remove).toHaveBeenCalledWith('crm_tag', 'j1'))
      expect(pushMock).not.toHaveBeenCalled()
    })
  })

  describe('widgetOptions.deferred — stage instead of writing junction rows immediately', () => {
    const deferredTagsField: FieldDescriptor = {
      ...tagsField,
      widgetOptions: { deferred: true },
    }

    it('adding a tag stages it (onChange with a pending diff) instead of calling ops.create', async () => {
      const ops = stubOps({
        list: vi.fn(async (entity: string) => (entity === 'crm_tag' ? [] : companies)),
      })
      const { onChange } = renderWidget(deferredTagsField, ops)

      const input = screen.getByRole('combobox')
      fireEvent.click(input)
      fireEvent.change(input, { target: { value: 'glo' } })
      fireEvent.click(await screen.findByText('Globex'))

      expect(await screen.findByText('Globex')).toBeInTheDocument()
      expect(ops.create).not.toHaveBeenCalled()
      expect(onChange).toHaveBeenCalledWith({
        toLink: [{ id: 'c2', name: 'Globex', status: 'lead' }],
        toUnlinkJunctionIds: [],
      })
    })

    it('removing an already-persisted tag stages its junction id for removal instead of calling ops.remove', async () => {
      const ops = stubOps({
        list: vi.fn(async (entity: string) => (entity === 'crm_tag' ? junctions : companies)),
      })
      const { onChange } = renderWidget(deferredTagsField, ops)
      expect(await screen.findByText('Acme')).toBeInTheDocument()

      const tag = screen.getByText('Acme').closest('.MuiChip-root')!
      fireEvent.click(tag.querySelector('.MuiChip-deleteIcon')!)

      await waitFor(() => expect(screen.queryByText('Acme')).not.toBeInTheDocument())
      expect(ops.remove).not.toHaveBeenCalled()
      expect(onChange).toHaveBeenCalledWith({ toLink: [], toUnlinkJunctionIds: ['j1'] })
    })

    it('removing a just-staged (not yet persisted) tag drops it back out of the pending diff entirely', async () => {
      const ops = stubOps({
        list: vi.fn(async (entity: string) => (entity === 'crm_tag' ? [] : companies)),
      })
      const { onChange } = renderWidget(deferredTagsField, ops)

      const input = screen.getByRole('combobox')
      fireEvent.click(input)
      fireEvent.change(input, { target: { value: 'glo' } })
      fireEvent.click(await screen.findByText('Globex'))
      expect(await screen.findByText('Globex')).toBeInTheDocument()

      const tag = screen.getByText('Globex').closest('.MuiChip-root')!
      fireEvent.click(tag.querySelector('.MuiChip-deleteIcon')!)

      await waitFor(() => expect(screen.queryByText('Globex')).not.toBeInTheDocument())
      expect(ops.create).not.toHaveBeenCalled()
      expect(onChange).toHaveBeenLastCalledWith({ toLink: [], toUnlinkJunctionIds: [] })
    })

    describe('required: reports live fill state to required-relation-store', () => {
      const requiredDeferredTagsField: FieldDescriptor = { ...deferredTagsField, required: true }

      beforeEach(() => useHasLinksStore.setState({ hasLinks: {} }))

      it('reports true once the existing links resolve', async () => {
        const ops = stubOps({
          list: vi.fn(async (entity: string) => (entity === 'crm_tag' ? junctions : companies)),
        })
        renderWidget(requiredDeferredTagsField, ops)
        await waitFor(() => expect(useHasLinksStore.getState().hasLinks.tags).toBe(true))
      })

      it('reports false once the last existing link is staged for removal', async () => {
        const ops = stubOps({
          list: vi.fn(async (entity: string) => (entity === 'crm_tag' ? [junctions[0]] : companies)),
        })
        renderWidget(requiredDeferredTagsField, ops)
        const tag = (await screen.findByText('Acme')).closest('.MuiChip-root')!
        fireEvent.click(tag.querySelector('.MuiChip-deleteIcon')!)
        await waitFor(() => expect(useHasLinksStore.getState().hasLinks.tags).toBe(false))
      })

      it('reports false with no links at all, true once one is staged to link', async () => {
        const ops = stubOps({
          list: vi.fn(async (entity: string) => (entity === 'crm_tag' ? [] : companies)),
        })
        renderWidget(requiredDeferredTagsField, ops)
        await waitFor(() => expect(useHasLinksStore.getState().hasLinks.tags).toBe(false))

        const input = screen.getByRole('combobox')
        fireEvent.click(input)
        fireEvent.change(input, { target: { value: 'glo' } })
        fireEvent.click(await screen.findByText('Globex'))
        await waitFor(() => expect(useHasLinksStore.getState().hasLinks.tags).toBe(true))
      })

      it('a non-required deferred field never reports', async () => {
        const ops = stubOps({
          list: vi.fn(async (entity: string) => (entity === 'crm_tag' ? [] : companies)),
        })
        renderWidget(deferredTagsField, ops)
        await waitFor(() => expect(ops.list).toHaveBeenCalled())
        expect(useHasLinksStore.getState().hasLinks.tags).toBeUndefined()
      })
    })
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

  it('with no relation.formPath declared, clicking a row does not navigate (sale_lines/quote_lines posture)', async () => {
    const ops = stubOps()
    renderWidget(listField, ops)
    fireEvent.click(await screen.findByText('Acme'))
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('with relation.formPath declared, clicking a row navigates to that record\'s own form', async () => {
    const ops = stubOps()
    const navigableField: FieldDescriptor = {
      ...listField,
      relation: { ...listField.relation!, formPath: '/crm/lines/:id' },
    }
    renderWidget(navigableField, ops)
    fireEvent.click(await screen.findByText('Acme'))
    expect(pushMock).toHaveBeenCalledWith('/crm/lines/c1')
  })

  it('create line: creates with the inverse FK preset and hidden, row joins the grid', async () => {
    const created = { id: 'n1', name: 'New deal', contact_id: 'r1' }
    const ops = stubOps({ create: vi.fn(async () => created) })
    renderWidget(listField, ops)

    fireEvent.click(await screen.findByRole('button', { name: 'Create a new Crm' }))
    const dialog = await screen.findByRole('dialog')
    // The context owns the link: the inverse FK is preset, never asked for.
    expect(within(dialog).queryByText('contact_id')).not.toBeInTheDocument()

    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'New deal' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(ops.create).toHaveBeenCalledWith(
        'crm',
        expect.objectContaining({ name: 'New deal', contact_id: 'r1' }),
      ),
    )
    // The new record lands in the embedded list.
    expect(await screen.findByText('New deal')).toBeInTheDocument()
  })

  it('shows a hint before the record exists', () => {
    renderWidget(listField, stubOps(), { recordId: null })
    expect(screen.getByText('Available once the record has been saved.')).toBeInTheDocument()
  })

  it('hideLabel: true suppresses the caption but the embedded grid still loads', async () => {
    const ops = stubOps()
    renderWidget({ ...listField, hideLabel: true }, ops)
    expect(screen.queryByText('CRM records')).not.toBeInTheDocument()
    expect(await screen.findByText('Acme')).toBeInTheDocument()
  })

  it('widgetOptions.reverse: the last fetched row renders first (e.g. propertymanagement.rent_receipts)', async () => {
    const ops = stubOps()
    renderWidget({ ...listField, widgetOptions: { reverse: true } }, ops)
    await screen.findByText('Acme')
    const names = [...document.querySelectorAll('.MuiDataGrid-cell[data-field="name"]')].map((el) => el.textContent)
    // Fetch order is [Acme, Globex] (the `companies` fixture); reversed puts
    // Globex — the "last" one — first.
    expect(names).toEqual(['Globex', 'Acme'])
  })

  it('without widgetOptions.reverse, rows render in fetch order (unchanged default)', async () => {
    const ops = stubOps()
    renderWidget(listField, ops)
    await screen.findByText('Acme')
    const names = [...document.querySelectorAll('.MuiDataGrid-cell[data-field="name"]')].map((el) => el.textContent)
    expect(names).toEqual(['Acme', 'Globex'])
  })

  it('widgetOptions.relatedRelationField: resolves a m2m field declared on the row entity\'s own registered descriptor and merges it in as a plain column (e.g. the Role form\'s Views table showing each view\'s rights)', async () => {
    moduleRegistry.register({
      name: 'relation-list-test-fixture',
      routes: [
        {
          path: '/__test__/crm/:id',
          descriptor: {
            entity: 'crm',
            viewType: 'form',
            fields: [
              { name: 'name', type: 'text' },
              {
                name: 'labels',
                type: 'relation',
                relation: { entity: 'tag', kind: 'many2many', via: 'crm_tag' },
              },
            ],
          },
        },
      ],
    })

    const junctions: RelationRecord[] = [
      { id: 'j1', crm_id: 'c1', tag_id: 't1' },
      { id: 'j2', crm_id: 'c1', tag_id: 't2' },
    ]
    const tags: Record<string, RelationRecord> = { t1: { id: 't1', name: 'Hot' }, t2: { id: 't2', name: 'VIP' } }
    const ops = stubOps({
      list: vi.fn(async (entity: string, opts?: { filter?: Record<string, unknown> }) => {
        if (entity === 'crm') return companies
        if (entity === 'crm_tag') return junctions.filter((j) => j.crm_id === opts?.filter?.crm_id)
        if (entity === 'tag') return Object.values(tags)
        return []
      }),
    })

    renderWidget({ ...listField, widgetOptions: { relatedRelationField: 'labels' } }, ops)

    // c1 (Acme) has two linked tags, comma-joined; c2 (Globex) has none.
    expect(await screen.findByText('Hot, VIP')).toBeInTheDocument()
    const cells = [...document.querySelectorAll('.MuiDataGrid-cell[data-field="labels"]')].map((el) => el.textContent)
    expect(cells).toEqual(['Hot, VIP', ''])
  })

  describe('widgetOptions.deletable — trailing trash-icon column (e.g. sale_line/billing_line rows)', () => {
  it('without the flag, no delete column renders', async () => {
    const ops = stubOps()
    renderWidget(listField, ops)
    await screen.findByText('Acme')
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('clicking the trash icon removes the row only after ops.remove resolves (never optimistic)', async () => {
    let resolveRemove: () => void = () => {}
    const removePromise = new Promise<void>((resolve) => {
      resolveRemove = resolve
    })
    const ops = stubOps({ remove: vi.fn(() => removePromise) })
    renderWidget({ ...listField, widgetOptions: { deletable: true } }, ops)
    await screen.findByText('Acme')

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0])
    expect(ops.remove).toHaveBeenCalledWith('crm', 'c1')

    // Still visible while the request is in flight.
    expect(screen.getByText('Acme')).toBeInTheDocument()

    resolveRemove()
    await waitFor(() => expect(screen.queryByText('Acme')).not.toBeInTheDocument())
    expect(screen.getByText('Globex')).toBeInTheDocument()
  })

  it('a rejected delete leaves the row in place and surfaces the error', async () => {
    const ops = stubOps({
      remove: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    renderWidget({ ...listField, widgetOptions: { deletable: true } }, ops)
    await screen.findByText('Acme')

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0])

    expect(await screen.findByText('boom')).toBeInTheDocument()
    expect(screen.getByText('Acme')).toBeInTheDocument()
  })
})

describe('widgetOptions.multiCreate — bulk-add checkbox wizard (e.g. the Role form\'s Views table)', () => {
    const permissionRowForm: ViewDescriptor = {
      entity: 'permission_row',
      viewType: 'form',
      fields: [
        { name: 'owner_id', type: 'relation', relation: { entity: 'owner', kind: 'many2one' } },
        { name: 'view', type: 'relation', relation: { entity: 'catalog', kind: 'many2one', labelField: 'name' } },
      ],
    }
    const multiCreateField: FieldDescriptor = {
      name: 'view_permissions',
      label: 'Views',
      type: 'relation',
      relation: { entity: 'permission_row', kind: 'one2many', inverseField: 'owner_id', labelField: 'view' },
      widgetOptions: { multiCreate: { field: 'view', groupByModule: true } },
    }
    const catalogRows: RelationRecord[] = [
      { id: 'view_a', name: 'Alpha view' },
      { id: 'view_b', name: 'Beta view' },
    ]

    beforeEach(() => {
      moduleRegistry.register({
        name: 'permission-row-fixture',
        routes: [{ path: '/__test__/permission-row/:id', descriptor: permissionRowForm }],
      })
      moduleRegistry.register(
        {
          name: 'app-a-fixture',
          routes: [{ path: '/__test__/app-a/list', descriptor: { entity: 'view_a', viewType: 'tree', fields: [] } }],
        },
        { appMode: true, displayName: 'App A' },
      )
      moduleRegistry.register(
        {
          name: 'app-b-fixture',
          routes: [{ path: '/__test__/app-b/list', descriptor: { entity: 'view_b', viewType: 'tree', fields: [] } }],
        },
        { appMode: true, displayName: 'App B' },
      )
    })

    function opsFor(existingRows: RelationRecord[] = []) {
      const created: Record<string, unknown>[] = []
      const ops: RelationOps = {
        list: vi.fn(async (entity: string) => {
          if (entity === 'permission_row') return existingRows
          if (entity === 'catalog') return catalogRows
          return []
        }),
        get: vi.fn(async (_entity, id) => ({ id })),
        create: vi.fn(async (_entity, body) => {
          created.push(body as Record<string, unknown>)
          return { id: `pr${created.length}`, ...(body as object) }
        }),
        remove: vi.fn(async () => {}),
      }
      return { ops, created }
    }

    it('shows "Add <label>" instead of "Create a new <entity>", opening the bulk picker over the target catalog', async () => {
      const { ops } = opsFor()
      renderWidget(multiCreateField, ops)
      expect(screen.queryByRole('button', { name: /Create a new/i })).not.toBeInTheDocument()

      fireEvent.click(await screen.findByRole('button', { name: 'Add Views' }))
      expect(await screen.findByText('Alpha view')).toBeInTheDocument()
      expect(screen.getByText('Beta view')).toBeInTheDocument()
    })

    it('typing filters the picker client-side', async () => {
      const { ops } = opsFor()
      renderWidget(multiCreateField, ops)
      fireEvent.click(await screen.findByRole('button', { name: 'Add Views' }))
      await screen.findByText('Alpha view')

      fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'beta' } })
      expect(screen.queryByText('Alpha view')).not.toBeInTheDocument()
      expect(screen.getByText('Beta view')).toBeInTheDocument()
    })

    it('excludes views this owner already has a row for — no adding the same one twice', async () => {
      const { ops } = opsFor([{ id: 'pr1', owner_id: 'r1', view: 'view_a' }])
      renderWidget(multiCreateField, ops)
      await waitFor(() => expect(ops.list).toHaveBeenCalledWith('permission_row', expect.anything()))

      fireEvent.click(screen.getByRole('button', { name: 'Add Views' }))
      await screen.findByText('Beta view')
      expect(screen.queryByText('Alpha view')).not.toBeInTheDocument()
    })

    it('groupByModule offers an App filter — picking one narrows the picker to that app\'s own views', async () => {
      const { ops } = opsFor()
      renderWidget(multiCreateField, ops)
      fireEvent.click(await screen.findByRole('button', { name: 'Add Views' }))
      await screen.findByText('Alpha view')
      expect(screen.getByText('Beta view')).toBeInTheDocument()

      fireEvent.mouseDown(screen.getByLabelText('App'))
      fireEvent.click(await screen.findByRole('option', { name: 'App A' }))

      expect(await screen.findByText('Alpha view')).toBeInTheDocument()
      expect(screen.queryByText('Beta view')).not.toBeInTheDocument()
    })

    it('checking rows then Add creates one row per selection, each preset with the inverse FK', async () => {
      const { ops, created } = opsFor()
      renderWidget(multiCreateField, ops)
      fireEvent.click(await screen.findByRole('button', { name: 'Add Views' }))
      await screen.findByText('Alpha view')

      // Clicking a DataGrid row toggles its checkbox (checkboxSelection is on,
      // disableRowSelectionOnClick is NOT set) — avoids poking MUI's own
      // internal checkbox DOM structure directly.
      fireEvent.click(screen.getByText('Alpha view'))
      fireEvent.click(screen.getByText('Beta view'))

      fireEvent.click(await screen.findByRole('button', { name: 'Add (2)' }))

      await waitFor(() => expect(created).toHaveLength(2))
      expect(created).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ owner_id: 'r1', view: 'view_a' }),
          expect.objectContaining({ owner_id: 'r1', view: 'view_b' }),
        ]),
      )
    })
  })
})

describe('create-from-search: primary color', () => {
  // The dropdown create rows are <Typography color="primary">: MUI bakes the
  // resolved color into a dynamic css-hash class (no static "colorPrimary"
  // utility class for Typography in this MUI version), so comparing against a
  // same-render reference Typography's computed color is the reliable check —
  // it resolves under whatever theme is active (this suite has no
  // AppThemeProvider; the app's real ThemeProvider carries the same prop
  // through to the same resolution).
  function primaryReferenceColor() {
    const { container, unmount } = render(
      <Typography component="span" color="primary">
        ref
      </Typography>,
    )
    const color = getComputedStyle(container.querySelector('span')!).color
    unmount()
    return color
  }

  it('the m2o dropdown create row matches the primary text color', async () => {
    const reference = primaryReferenceColor()
    const ops = stubOps()
    renderWidget(searchField, ops)
    const input = screen.getByRole('combobox')
    fireEvent.click(input)
    fireEvent.change(input, { target: { value: 'ac' } })
    const createOption = await screen.findByText('Create a new Contact')
    expect(getComputedStyle(createOption).color).toBe(reference)
  })

  it('the m2m dropdown create row matches the primary text color', async () => {
    const reference = primaryReferenceColor()
    const ops = stubOps({
      list: vi.fn(async (entity: string) =>
        entity === 'crm_tag' ? [] : companies,
      ),
    })
    renderWidget(tagsField, ops)
    const input = screen.getByRole('combobox')
    fireEvent.click(input)
    fireEvent.change(input, { target: { value: 'ac' } })
    const createOption = await screen.findByText('Create a new Tag')
    expect(getComputedStyle(createOption).color).toBe(reference)
  })

  it('the o2m "Create a new" button carries MUI\'s primary-color class', async () => {
    // Button resolves color through CSS custom properties (--variant-textColor)
    // that jsdom's computed-style engine doesn't fully thread through — the
    // reliable check here is Button's own static "CSS API" class, which MUI
    // documents as stable: MuiButton-colorPrimary is present iff color="primary".
    renderWidget(listField, stubOps())
    const button = await screen.findByRole('button', { name: 'Create a new Crm' })
    expect(button.className).toContain('MuiButton-colorPrimary')
  })
})

const totalsField: FieldDescriptor = {
  name: 'sale_totals',
  label: 'Totals',
  type: 'totals',
  hideLabel: true,
  store: false,
  relation: { entity: 'sale_line', kind: 'one2many', inverseField: 'invoice_id' },
}

describe('totals/recap', () => {
  it('sums each line\'s own already-computed total into one aggregate tax row', async () => {
    const lines: RelationRecord[] = [
      // total is server-computed (handler.go's computeLineTotal) — the
      // widget only ever sums it, never re-derives tax from tax_rate itself
      // once it's present.
      { id: 'l1', quantity: 2, unit_price: 50, tax_rate: 0.2, total: 120 }, // 100 HT, 20 tax
      { id: 'l2', quantity: 3, unit_price: 10, tax_rate: 0.1, total: 33 }, // 30 HT, 3 tax
      { id: 'l3', quantity: 1, unit_price: 100, tax_rate: 0.2, total: 120 }, // 100 HT, 20 tax
    ]
    const ops = stubOps({ list: vi.fn(async () => lines) })
    renderWidget(totalsField, ops, { recordId: 'inv1' })

    await waitFor(() => expect(ops.list).toHaveBeenCalledWith('sale_line', expect.objectContaining({ filter: { invoice_id: 'inv1' } })))

    // subtotal = 100 + 30 + 100 = 230; tax = (120-100) + (33-30) + (120-100) = 43; total = 273
    expect(await screen.findByText('230.00')).toBeInTheDocument()
    expect(screen.getByText('Tax:', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('43.00')).toBeInTheDocument()
    expect(screen.getByText('273.00')).toBeInTheDocument()
  })

  it('falls back to tax_rate applied inline when total is absent (quote_line, which never got the many2many taxes/Total column)', async () => {
    const lines: RelationRecord[] = [
      { id: 'l1', quantity: 2, unit_price: 50, tax_rate: 0.2 }, // 100 HT, 20 tax
      { id: 'l2', quantity: 3, unit_price: 10, tax_rate: 0.1 }, // 30 HT, 3 tax
    ]
    const ops = stubOps({ list: vi.fn(async () => lines) })
    renderWidget(totalsField, ops, { recordId: 'q1' })

    // subtotal = 100 + 30 = 130; tax = 20 + 3 = 23; total = 153
    expect(await screen.findByText('130.00')).toBeInTheDocument()
    expect(screen.getByText('23.00')).toBeInTheDocument()
    expect(screen.getByText('153.00')).toBeInTheDocument()
  })

  it('renders nothing for an unsaved record (no id to scope lines to)', () => {
    renderWidget(totalsField, stubOps(), { recordId: null })
    expect(screen.queryByText('Untaxed Amount:', { exact: false })).not.toBeInTheDocument()
  })

  it('treats a missing quantity column as 1, not 0 (e.g. propertymanagement billing lines, priced flat with no quantity concept)', async () => {
    const lines: RelationRecord[] = [
      { id: 'l1', unit_price: 800, tax_rate: 0 }, // rent — no `quantity` key at all
      { id: 'l2', unit_price: 50, tax_rate: 0.2 }, // condo fees
    ]
    const ops = stubOps({ list: vi.fn(async () => lines) })
    renderWidget(totalsField, ops, { recordId: 'p1' })

    // subtotal = 800 + 50 = 850 (NOT 0 — a real 0 × price bug would render 0.00)
    expect(await screen.findByText('850.00')).toBeInTheDocument()
    expect(screen.getByText('10.00')).toBeInTheDocument()
    expect(screen.getByText('860.00')).toBeInTheDocument()
  })

  it('still respects a REAL quantity of 0 on entities that do have the column (never silently upgraded to 1)', async () => {
    const lines: RelationRecord[] = [{ id: 'l1', quantity: 0, unit_price: 100, tax_rate: 0.2 }]
    const ops = stubOps({ list: vi.fn(async () => lines) })
    renderWidget(totalsField, ops, { recordId: 'inv1' })

    // Untaxed amount, the 20% tax line, and the grand total all read 0.00 —
    // a wrongly-upgraded-to-1 quantity would instead show 100.00/20.00/120.00.
    await waitFor(() => expect(screen.getAllByText('0.00')).toHaveLength(3))
  })
})
