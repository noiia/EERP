import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
import { resolveWidget, type FieldDescriptor } from './descriptor'
import { RelationOpsProvider, type RelationOps, type RelationRecord } from './relation-ops'
import { RelationColorTagsWidget } from './relation-widgets'
import { fieldWidget, type WidgetProps } from './widgets'

// relation/colortags: a many2many over records carrying a color — chips with a
// color dot, a "create" dialog asking only a name and a color.

const colorsField: FieldDescriptor = {
  name: 'color_groups',
  label: 'Color groups',
  type: 'relation',
  widget: 'colortags',
  relation: {
    entity: 'color',
    kind: 'many2many',
    via: 'task_color',
    viaFields: { own: 'task_id', related: 'color_id' },
    labelField: 'name',
  },
}

const groups: RelationRecord[] = [
  { id: 'c1', name: 'Red', color: '#ff0000' },
  { id: 'c2', name: 'Green', color: '#00ff00' },
  { id: 'c3', name: 'Blue', color: '#0000ff' },
]

function stubOps(
  junctions: RelationRecord[] = [],
  overrides: Partial<RelationOps> = {},
): RelationOps {
  return {
    list: vi.fn(async (entity: string) => (entity === 'task_color' ? junctions : groups)),
    get: vi.fn(),
    create: vi.fn(async (entity: string, body: Record<string, unknown>) =>
      entity === 'color' ? { id: 'c-new', ...body } : { id: 'j-new', ...body },
    ),
    remove: vi.fn(async () => undefined),
    ...overrides,
  }
}

function renderWidget(
  ops: RelationOps,
  props: Partial<WidgetProps> & { onLinksChange?: () => void } = {},
) {
  const Widget = fieldWidget(colorsField)
  return render(
    <RelationOpsProvider ops={ops}>
      <Widget
        field={colorsField}
        value={undefined}
        onChange={vi.fn()}
        entity="task"
        recordId="t1"
        {...props}
      />
    </RelationOpsProvider>,
  )
}

const dotOf = (label: string) =>
  screen
    .getByText(label)
    .closest('.MuiChip-root')!
    .querySelector('[data-testid="color-dot"]') as HTMLElement

describe('relation/colortags', () => {
  it('is a many2many-only widget', () => {
    expect(resolveWidget(colorsField)).toBe('colortags')
    expect(() =>
      resolveWidget({
        ...colorsField,
        relation: { entity: 'color', kind: 'one2many', inverseField: 'task_id' },
      }),
    ).toThrow(/colortags/)
    expect(() =>
      resolveWidget({ ...colorsField, relation: { entity: 'color', kind: 'many2one' } }),
    ).toThrow(/colortags/)
  })

  it('shows the linked groups as chips with their color, in junction creation order', async () => {
    const ops = stubOps([
      { id: 'j2', task_id: 't1', color_id: 'c2' },
      { id: 'j1', task_id: 't1', color_id: 'c1' },
    ])
    renderWidget(ops)
    expect(await screen.findByText('Green')).toBeInTheDocument()
    expect(ops.list).toHaveBeenCalledWith('task_color', {
      filter: { task_id: 't1' },
      order: 'created_at',
      pageSize: 100,
    })
    const chips = screen
      .getAllByTestId('color-dot')
      .map((d) => d.closest('.MuiChip-root')!.textContent)
    expect(chips).toEqual(['Green', 'Red'])
    expect(dotOf('Red').style.background).toBe('rgb(255, 0, 0)')
  })

  it('links a searched group and unlinks a chip through the junction', async () => {
    const onLinksChange = vi.fn()
    const ops = stubOps([{ id: 'j1', task_id: 't1', color_id: 'c1' }])
    renderWidget(ops, { onLinksChange })
    await screen.findByText('Red')

    const input = screen.getByRole('combobox')
    fireEvent.click(input)
    fireEvent.change(input, { target: { value: 'b' } })
    fireEvent.click(await screen.findByText('Blue'))
    await waitFor(() =>
      expect(ops.create).toHaveBeenCalledWith('task_color', { task_id: 't1', color_id: 'c3' }),
    )
    await waitFor(() => expect(onLinksChange).toHaveBeenCalledTimes(1))

    const chip = screen.getByText('Red').closest('.MuiChip-root')!
    fireEvent.click(chip.querySelector('.MuiChip-deleteIcon')!)
    await waitFor(() => expect(ops.remove).toHaveBeenCalledWith('task_color', 'j1'))
    await waitFor(() => expect(onLinksChange).toHaveBeenCalledTimes(2))
  })

  it('creates a group from a name and a color only, then links it', async () => {
    const ops = stubOps()
    renderWidget(ops)
    const input = screen.getByRole('combobox')
    fireEvent.click(input)
    fireEvent.change(input, { target: { value: 'Urgent' } })
    fireEvent.click(await screen.findByText('Create a new Color'))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Urgent')
    // Only these two inputs: no generic entity form.
    expect(dialog.querySelectorAll('input')).toHaveLength(2)
    fireEvent.input(within(dialog).getByLabelText('Color'), { target: { value: '#abcdef' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(ops.create).toHaveBeenCalledWith('color', { name: 'Urgent', color: '#abcdef' }),
    )
    await waitFor(() =>
      expect(ops.create).toHaveBeenCalledWith('task_color', { task_id: 't1', color_id: 'c-new' }),
    )
    expect(await screen.findByText('Urgent')).toBeInTheDocument()
    expect(dotOf('Urgent').style.background).toBe('rgb(171, 205, 239)')
  })

  it('keeps the dialog open with the error when the group is refused', async () => {
    const ops = stubOps([], {
      create: vi.fn(async () => {
        throw new Error('color must be a #rrggbb hex color')
      }),
    })
    renderWidget(ops)
    const input = screen.getByRole('combobox')
    fireEvent.click(input)
    fireEvent.change(input, { target: { value: ' ' } })
    fireEvent.click(await screen.findByText('Create a new Color'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Create' })).toBeDisabled() // a blank name
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'X' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(await within(dialog).findByText('color must be a #rrggbb hex color')).toBeInTheDocument()
  })

  it('read-only: chips only, no picker and no unlink', async () => {
    renderWidget(stubOps([{ id: 'j1', task_id: 't1', color_id: 'c1' }]), { disabled: true })
    expect(await screen.findByText('Red')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(document.querySelector('.MuiChip-deleteIcon')).toBeNull()
  })

  it('is the exported component the dispatch resolves', () => {
    expect(fieldWidget(colorsField)).toBe(RelationColorTagsWidget)
  })
})
