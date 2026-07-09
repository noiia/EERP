import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import type { FieldDescriptor, ViewDescriptor } from './descriptor'
import { DEFAULT_NUMBER_FORMAT, useFormatStore } from './format-store'
import { LayoutForm } from './layout-renderer'

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
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
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
      viewType: 'form',
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
      viewType: 'form',
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

describe('LayoutForm — declarative states react to draft edits', () => {
  it('visible: false unmounts the field; toggling it back on shows the PRESERVED value', () => {
    const descriptor: ViewDescriptor = {
      entity: 'crm',
      viewType: 'form',
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
