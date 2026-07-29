import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import Typography from '@mui/material/Typography'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
})

describe('relation/tags (many2many)', () => {
  const junctions: RelationRecord[] = [
    { id: 'j1', crm_id: 'r1', tag_id: 'c1' },
    { id: 'j2', crm_id: 'r1', tag_id: 'c2' },
  ]

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
