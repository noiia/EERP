import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FieldDescriptor, ViewDescriptor } from './descriptor'
import { DEFAULT_NUMBER_FORMAT, useFormatStore } from './format-store'
import { LayoutForm } from './layout-renderer'
import { NotebookOpsProvider, type NotebookOps, type NotebookPageRecord } from './notebook-ops'
import { useSessionStore, type Identity } from './session-store'

// LayoutForm is the single entry point FormRenderer and the relation
// create-from-search wizard both use — direct coverage here for grouping,
// ordering, titles, and the `hidden` skip, independent of the full form
// store/renderer stack (those are covered in renderers.test.tsx).

beforeEach(() => {
  useFormatStore.setState({ ...DEFAULT_NUMBER_FORMAT })
})

function textField(name: string): FieldDescriptor {
  return { name, label: name.toUpperCase(), type: 'text' }
}

function renderLayout(descriptor: ViewDescriptor, draft: Record<string, unknown> = {}) {
  const onFieldChange = vi.fn()
  render(
    <LayoutForm
      descriptor={descriptor}
      draft={draft}
      onFieldChange={onFieldChange}
      entity="crm"
      recordId={null}
    />,
  )
  return { onFieldChange }
}

describe('LayoutForm', () => {
  it('implicit layout (no descriptor.layout): renders every field in declaration order', () => {
    // viewType 'tree' (not 'form'): this is the GENERIC flat-fallback used by
    // every non-form view — the form-specific header/two-column default
    // (docs/roadmaps/responsive-displays.md, Phase 3) has its own describe
    // block below.
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'tree',
      fields: [textField('first'), textField('second'), textField('third')],
    }
    renderLayout(descriptor)
    const inputs = screen.getAllByRole('textbox')
    expect(inputs.map((i) => i.getAttribute('id'))).toEqual([
      screen.getByLabelText('FIRST').id,
      screen.getByLabelText('SECOND').id,
      screen.getByLabelText('THIRD').id,
    ])
  })

  it('an explicit layout renders fields in the LAYOUT order, not the fields declaration order', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      // Declared in one order...
      fields: [textField('first'), textField('second')],
      // ...but the layout puts 'second' first.
      layout: [
        { kind: 'group', children: [{ kind: 'field', name: 'second' }, { kind: 'field', name: 'first' }] },
      ],
    }
    renderLayout(descriptor)
    const inputs = screen.getAllByRole('textbox')
    expect(inputs[0]).toBe(screen.getByLabelText('SECOND'))
    expect(inputs[1]).toBe(screen.getByLabelText('FIRST'))
  })

  it('a section title renders as a heading above its fields', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [textField('a')],
      layout: [{ kind: 'section', title: 'Contact info', children: [{ kind: 'field', name: 'a' }] }],
    }
    renderLayout(descriptor)
    expect(screen.getByText('Contact info')).toBeInTheDocument()
    expect(screen.getByLabelText('A')).toBeInTheDocument()
  })

  it('a row groups its fields — both render, side by side in the tree', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [textField('a'), textField('b')],
      layout: [{ kind: 'row', children: [{ kind: 'field', name: 'a' }, { kind: 'field', name: 'b' }] }],
    }
    renderLayout(descriptor)
    expect(screen.getByLabelText('A')).toBeInTheDocument()
    expect(screen.getByLabelText('B')).toBeInTheDocument()
  })

  it('nested containers (section > row > group) still resolve every leaf', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [textField('a'), textField('b'), textField('c')],
      layout: [
        {
          kind: 'section',
          title: 'Nested',
          children: [
            {
              kind: 'row',
              children: [
                { kind: 'field', name: 'a' },
                { kind: 'group', children: [{ kind: 'field', name: 'b' }, { kind: 'field', name: 'c' }] },
              ],
            },
          ],
        },
      ],
    }
    renderLayout(descriptor)
    expect(screen.getByLabelText('A')).toBeInTheDocument()
    expect(screen.getByLabelText('B')).toBeInTheDocument()
    expect(screen.getByLabelText('C')).toBeInTheDocument()
  })

  it('`hidden` skips a field leaf entirely — used by the o2m create wizard for its preset inverse FK', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'tree',
      fields: [textField('visible'), textField('inverse_fk')],
    }
    const onFieldChange = vi.fn()
    render(
      <LayoutForm
        descriptor={descriptor}
        draft={{}}
        onFieldChange={onFieldChange}
        entity="crm"
        recordId={null}
        hidden={new Set(['inverse_fk'])}
      />,
    )
    expect(screen.getByLabelText('VISIBLE')).toBeInTheDocument()
    expect(screen.queryByLabelText('INVERSE_FK')).not.toBeInTheDocument()
  })

  it('edits route through onFieldChange with the field name and new value', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'tree',
      fields: [textField('name')],
    }
    const { onFieldChange } = renderLayout(descriptor, { name: 'Ada' })
    const input = screen.getByLabelText('NAME')
    expect(input).toHaveValue('Ada')
    fireEvent.change(input, { target: { value: 'Grace' } })
    expect(onFieldChange).toHaveBeenCalledWith('name', 'Grace')
  })

  it('a computed field (has `compute`) renders disabled', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [{ name: 'total', label: 'Total', type: 'number', compute: 'crm.total' }],
    }
    renderLayout(descriptor, { total: 42 })
    expect(screen.getByLabelText('Total')).toBeDisabled()
  })
})

// docs/roadmaps/responsive-displays.md, Phase 3: the DEFAULT anatomy for an
// un-layouted `viewType: 'form'` descriptor — header (picture + big title)
// then a two-column group holding everything else. Only forms with no
// explicit `layout` get this; an explicit layout (any viewType) is untouched,
// pinned above.
describe('LayoutForm — default form anatomy (viewType "form", no explicit layout)', () => {
  it('the first text field renders BIG (title variant, placeholder label, no boxed TextField)', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [textField('name'), textField('email')],
    }
    renderLayout(descriptor, { name: 'Ada' })
    // No floating/boxed label for the title field...
    expect(screen.queryByLabelText('NAME')).not.toBeInTheDocument()
    // ...instead a placeholder-labeled input carrying the value.
    expect(screen.getByPlaceholderText('NAME')).toHaveValue('Ada')
    // The second text field still renders normally (boxed label).
    expect(screen.getByLabelText('EMAIL')).toBeInTheDocument()
  })

  it('a boolean `widget: picture` field joins the title field in the header, both before every other field', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [
        { name: 'picture', label: 'Picture', type: 'boolean', widget: 'picture' },
        textField('name'),
        textField('email'),
      ],
    }
    renderLayout(descriptor)
    // The picture widget renders its own frame/label (covered in
    // picture-widgets tests) — here we only need proof it mounted at all,
    // alongside the title field, and that 'email' (a plain column field)
    // still renders through the normal widget path.
    expect(screen.getByText('Picture')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('NAME')).toBeInTheDocument()
    expect(screen.getByLabelText('EMAIL')).toBeInTheDocument()
  })

  it('no text field at all: no title, no header — every field lands in the columns group', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [{ name: 'total', label: 'Total', type: 'number' }],
    }
    renderLayout(descriptor, { total: 42 })
    expect(screen.getByLabelText('Total')).toBeInTheDocument()
  })

  it('required still applies to the title field — the big style does not eat the affordance', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [{ name: 'name', label: 'Name', type: 'text', required: true }],
    }
    renderLayout(descriptor)
    expect(screen.getByPlaceholderText('Name')).toBeRequired()
  })

  it('an EXPLICIT layout on a form view is untouched — no synthesized header/columns', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [textField('name'), textField('email')],
      layout: [{ kind: 'group', children: [{ kind: 'field', name: 'name' }, { kind: 'field', name: 'email' }] }],
    }
    renderLayout(descriptor)
    // Both render through the NORMAL (boxed-label) widget path — no title variant.
    expect(screen.getByLabelText('NAME')).toBeInTheDocument()
    expect(screen.getByLabelText('EMAIL')).toBeInTheDocument()
  })
})

// docs/roadmaps/responsive-displays.md, Phase 4: the synthesized notebook
// and its always-present Settings page.
describe('LayoutForm — the synthesized notebook', () => {
  function longField(name: string): FieldDescriptor {
    return { name, label: name.toUpperCase(), type: 'text', widget: 'long' }
  }

  it('renders a "Settings" tab holding the widget:"long" fields, even alongside the header/columns', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [textField('name'), textField('email'), longField('notes')],
    }
    renderLayout(descriptor, { notes: 'hello' })
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument()
    // The columns field renders normally...
    expect(screen.getByLabelText('EMAIL')).toBeInTheDocument()
    // ...and the long field, moved onto the Settings page, still renders.
    expect(screen.getByLabelText('NOTES')).toHaveValue('hello')
  })

  it('renders a Tab per page and switches which page is VISIBLE — but both stay mounted', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [textField('name'), longField('notes')],
      layout: [
        {
          kind: 'notebook',
          children: [
            { kind: 'page', title: 'First', children: [{ kind: 'field', name: 'name' }] },
            { kind: 'page', title: 'Second', children: [{ kind: 'field', name: 'notes' }] },
          ],
        },
      ],
    }
    renderLayout(descriptor, { name: 'Ada', notes: 'kept' })

    // Both tabs exist; both fields are in the DOM from the start (never
    // unmounted), the inactive one just hidden.
    expect(screen.getByRole('tab', { name: 'First' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Second' })).toBeInTheDocument()
    expect(screen.getByLabelText('NAME')).toBeInTheDocument()
    expect(screen.getByLabelText('NOTES')).toBeInTheDocument()
    expect(screen.getByLabelText('NOTES').closest('[hidden]')).not.toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Second' }))
    expect(screen.getByLabelText('NAME').closest('[hidden]')).not.toBeNull()
    expect(screen.getByLabelText('NOTES').closest('[hidden]')).toBeNull()
    // Still the SAME input, never remounted.
    expect(screen.getByLabelText('NOTES')).toHaveValue('kept')
  })

  it('a notebook with no long field still renders — the Settings tab, empty', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [textField('name')],
    }
    renderLayout(descriptor)
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument()
  })
})

// Runtime, per-record notebook pages (docs/roadmaps/responsive-displays.md,
// Phase 5): the notebook renderer appends stored pages + a "+ Add page"
// control after the declared ones, ONLY when a NotebookOpsProvider is
// mounted — absent it (every earlier describe block in this file), the
// notebook renders exactly as Phase 4 left it, proven above.
describe('LayoutForm — runtime notebook pages (Phase 5)', () => {
  const formDescriptor: ViewDescriptor = {
    entity: 'crm',
    viewType: 'form',
    fields: [textField('name')],
  }

  function identityWith(permissions: string[]): Identity {
    return { userId: 'u1', tenantId: 't1', roles: ['tester'], permissions }
  }

  function fakeOps(overrides: Partial<NotebookOps> = {}): NotebookOps {
    return {
      list: vi.fn(async () => []),
      create: vi.fn(async (_table, _record, title) => ({
        id: 'new-1',
        title,
        content: '',
        position: 0,
      })),
      update: vi.fn(async (id, patch) => ({ id, position: 0, ...patch })),
      remove: vi.fn(async () => undefined),
      ...overrides,
    }
  }

  function renderWithOps(
    ops: NotebookOps,
    {
      recordId = 'rec-1',
      onFieldChange = vi.fn<(name: string, value: unknown) => void>(),
    }: { recordId?: string | null; onFieldChange?: (name: string, value: unknown) => void } = {},
  ) {
    render(
      <NotebookOpsProvider ops={ops}>
        <LayoutForm
          descriptor={formDescriptor}
          draft={{ name: 'Ada' }}
          onFieldChange={onFieldChange}
          entity="crm"
          recordId={recordId}
        />
      </NotebookOpsProvider>,
    )
    return { onFieldChange }
  }

  beforeEach(() => {
    useSessionStore.setState({ identity: null })
  })

  it('no NotebookOpsProvider: no stored tabs, no add control — exactly Phase 4 behavior', () => {
    renderLayout(formDescriptor)
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add page/i })).not.toBeInTheDocument()
  })

  it('lists stored pages as extra tabs after the declared ones, labeled with their OWN (untranslated) title', async () => {
    const ops = fakeOps({
      list: vi.fn(async () => [
        { id: 'p1', title: 'Meeting notes', content: 'hello', position: 0 } as NotebookPageRecord,
      ]),
    })
    renderWithOps(ops)
    expect(await screen.findByRole('tab', { name: 'Meeting notes' })).toBeInTheDocument()
    expect(ops.list).toHaveBeenCalledWith('crm', 'rec-1')
  })

  it('the add control is HIDDEN entirely without notebook_pages:notebook_pages:write', () => {
    useSessionStore.setState({ identity: identityWith([]) })
    renderWithOps(fakeOps())
    expect(screen.queryByRole('button', { name: /add page/i })).not.toBeInTheDocument()
  })

  it('the add control is disabled with a hint until the record has an id — the picture-widget posture', () => {
    useSessionStore.setState({ identity: identityWith(['notebook_pages:notebook_pages:write']) })
    renderWithOps(fakeOps(), { recordId: null })
    expect(screen.getByRole('button', { name: /add page/i })).toBeDisabled()
  })

  it('clicking "+ Add page" creates a page and switches the active tab to it', async () => {
    useSessionStore.setState({ identity: identityWith(['notebook_pages:notebook_pages:write']) })
    const ops = fakeOps()
    renderWithOps(ops)

    fireEvent.click(screen.getByRole('button', { name: /add page/i }))

    expect(await screen.findByRole('tab', { name: 'New page' })).toBeInTheDocument()
    expect(ops.create).toHaveBeenCalledWith('crm', 'rec-1', 'New page')
    // The new page's own editor is now showing (its tab became active).
    expect(await screen.findByLabelText('Title')).toHaveValue('New page')
  })

  it('editing and saving a stored page NEVER calls onFieldChange — it never dirties the record form', async () => {
    useSessionStore.setState({ identity: identityWith(['notebook_pages:notebook_pages:write']) })
    const ops = fakeOps({
      list: vi.fn(async () => [
        { id: 'p1', title: 'Notes', content: 'v1', position: 0 } as NotebookPageRecord,
      ]),
    })
    const { onFieldChange } = renderWithOps(ops)

    fireEvent.click(await screen.findByRole('tab', { name: 'Notes' }))
    fireEvent.change(await screen.findByLabelText('Content'), { target: { value: 'v2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(ops.update).toHaveBeenCalledWith('p1', { title: 'Notes', content: 'v2' }))
    expect(onFieldChange).not.toHaveBeenCalled()
  })

  it('a failed save reverts the local edit and shows an error', async () => {
    useSessionStore.setState({ identity: identityWith(['notebook_pages:notebook_pages:write']) })
    const ops = fakeOps({
      list: vi.fn(async () => [
        { id: 'p1', title: 'Notes', content: 'v1', position: 0 } as NotebookPageRecord,
      ]),
      update: vi.fn(async () => {
        throw new Error('write denied')
      }),
    })
    renderWithOps(ops)

    fireEvent.click(await screen.findByRole('tab', { name: 'Notes' }))
    fireEvent.change(await screen.findByLabelText('Content'), { target: { value: 'v2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByText('write denied')
    expect(screen.getByLabelText('Content')).toHaveValue('v1')
  })

  it('deleting a stored page removes its tab and falls back to the Settings tab', async () => {
    useSessionStore.setState({ identity: identityWith(['notebook_pages:notebook_pages:write']) })
    const ops = fakeOps({
      list: vi.fn(async () => [
        { id: 'p1', title: 'Notes', content: 'v1', position: 0 } as NotebookPageRecord,
      ]),
    })
    renderWithOps(ops)

    fireEvent.click(await screen.findByRole('tab', { name: 'Notes' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Notes' })).not.toBeInTheDocument())
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument()
  })
})

// A controlled wrapper standing in for the form store: draft lives in React
// state, onFieldChange writes back into it — the same "edit re-renders with
// the new draft" cycle Zustand's subscription drives in the real form store.
// This is what proves states REACT to the user's own edits, not just to the
// initial draft.
function ControlledLayoutForm({
  descriptor,
  initialDraft,
}: {
  descriptor: ViewDescriptor
  initialDraft: Record<string, unknown>
}) {
  const [draft, setDraft] = useState(initialDraft)
  return (
    <LayoutForm
      descriptor={descriptor}
      draft={draft}
      onFieldChange={(name, value) => setDraft((d) => ({ ...d, [name]: value }))}
      entity="crm"
      recordId={null}
    />
  )
}

describe('LayoutForm — notebook tab switching preserves draft state', () => {
  it('editing a field on one page, switching tabs, and switching back shows the edit — nothing was reset', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [
        { name: 'name', label: 'Name', type: 'text' },
        { name: 'notes', label: 'Notes', type: 'text', widget: 'long' },
      ],
      layout: [
        {
          kind: 'notebook',
          children: [
            { kind: 'page', title: 'First', children: [{ kind: 'field', name: 'name' }] },
            { kind: 'page', title: 'Second', children: [{ kind: 'field', name: 'notes' }] },
          ],
        },
      ],
    }
    render(<ControlledLayoutForm descriptor={descriptor} initialDraft={{}} />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Second' }))
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'draft note' } })
    fireEvent.click(screen.getByRole('tab', { name: 'First' }))

    // Both edits survived the round trip through the other tab.
    expect(screen.getByLabelText('Name')).toHaveValue('Ada')
    fireEvent.click(screen.getByRole('tab', { name: 'Second' }))
    expect(screen.getByLabelText('Notes')).toHaveValue('draft note')
  })
})

describe('LayoutForm — declarative states react to draft edits', () => {
  it('visible: false unmounts the field; toggling it back on shows the PRESERVED value', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'tree',
      fields: [
        { name: 'status', label: 'Status', type: 'text' },
        {
          name: 'comment',
          label: 'Comment',
          type: 'text',
          states: { visible: { field: 'status', op: 'eq', value: 'lost' } },
        },
      ],
    }
    render(<ControlledLayoutForm descriptor={descriptor} initialDraft={{ status: 'won', comment: 'kept' }} />)

    // status='won': comment starts invisible, even though its draft value is set.
    expect(screen.queryByLabelText('Comment')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'lost' } })
    // Now visible — showing the value it had all along, never cleared.
    expect(screen.getByLabelText('Comment')).toHaveValue('kept')

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'won' } })
    expect(screen.queryByLabelText('Comment')).not.toBeInTheDocument()
  })

  it('readOnly: true disables the widget WITHOUT unmounting it, reacting to the same edit', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
      fields: [
        { name: 'locked', label: 'Locked', type: 'boolean' },
        {
          name: 'amount',
          label: 'Amount',
          type: 'number',
          states: { readOnly: { field: 'locked', op: 'eq', value: true } },
        },
      ],
    }
    render(<ControlledLayoutForm descriptor={descriptor} initialDraft={{ locked: false, amount: 10 }} />)

    expect(screen.getByLabelText('Amount')).not.toBeDisabled()
    fireEvent.click(screen.getByRole('switch', { name: 'Locked' }))
    expect(screen.getByLabelText('Amount')).toBeDisabled()
    // Still mounted, just disabled — unlike visible:false.
    expect(screen.getByLabelText('Amount')).toHaveValue('10.00')
  })
})
