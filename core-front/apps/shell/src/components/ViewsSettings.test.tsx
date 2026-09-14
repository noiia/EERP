import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ViewFieldsConfig } from '@eerp/core-front'

// The save is a Server Action; the component only sees its result object.
const saveMock = vi.fn()
vi.mock('@/lib/view-fields', () => ({
  setEntityViewFields: (entity: string, config: ViewFieldsConfig) => saveMock(entity, config),
}))

import ViewsSettings, { type ViewEntityRow } from './ViewsSettings'

async function pickOption(selectLabel: string, optionName: string) {
  fireEvent.mouseDown(screen.getByLabelText(selectLabel))
  fireEvent.click(await screen.findByRole('option', { name: optionName }))
}

const rows: ViewEntityRow[] = [
  {
    entity: 'crm',
    kanbanFields: [{ name: 'status', label: 'Status', type: 'selection', selection: { options: ['open', 'won'] } }],
    dateFields: [{ name: 'due_date', label: 'Due date', type: 'date' }],
    config: { kanbanStatusField: null, calendarDateField: null },
    defaults: {},
  },
]

describe('ViewsSettings', () => {
  beforeEach(() => {
    saveMock.mockReset()
    saveMock.mockResolvedValue({ ok: true })
  })

  it('lists each tree-view entity with its selection/date fields as choices, plus an Enable Graphs switch', () => {
    render(<ViewsSettings rows={rows} canEdit />)
    expect(screen.getByText('crm')).toBeInTheDocument()
    expect(screen.getByLabelText('Status field')).toBeInTheDocument()
    expect(screen.getByLabelText('Date field')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Enable Graphs' })).not.toBeChecked()
  })

  it('no revert button when the module declared no defaults for this entity', () => {
    render(<ViewsSettings rows={rows} canEdit />)
    expect(screen.queryByRole('button', { name: 'Revert to module settings' })).not.toBeInTheDocument()
  })

  it('saves a choice optimistically', async () => {
    render(<ViewsSettings rows={rows} canEdit />)
    await pickOption('Status field', 'Status')

    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith('crm', {
        kanbanStatusField: 'status',
        calendarDateField: null,
      }),
    )
  })

  it('reverts the choice and surfaces the message when the save fails', async () => {
    saveMock.mockResolvedValue({ ok: false, message: 'Forbidden: settings:views:write' })
    render(<ViewsSettings rows={rows} canEdit />)
    await pickOption('Status field', 'Status')

    expect(await screen.findByText('Forbidden: settings:views:write')).toBeInTheDocument()
    // Reverted: the select goes back to "None".
    expect(screen.getByLabelText('Status field')).toHaveTextContent('None')
  })

  it('renders read-only without the write permission', () => {
    render(<ViewsSettings rows={rows} canEdit={false} />)
    expect(screen.getByLabelText('Status field')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText(/settings:views:write permission/)).toBeInTheDocument()
  })

  it('renders an empty state when no tree views are registered', () => {
    render(<ViewsSettings rows={[]} canEdit />)
    expect(screen.getByText(/No list views are registered yet/)).toBeInTheDocument()
  })
})

describe('ViewsSettings — module-declared defaults', () => {
  const defaultedRows: ViewEntityRow[] = [
    {
      entity: 'crm',
      kanbanFields: [
        { name: 'status', label: 'Status', type: 'selection', selection: { options: ['open', 'won'] } },
        { name: 'priority', label: 'Priority', type: 'selection', selection: { options: ['low', 'high'] } },
      ],
      dateFields: [{ name: 'due_date', label: 'Due date', type: 'date' }],
      config: { kanbanStatusField: null, calendarDateField: null, enableGraphs: null },
      defaults: { kanbanStatusField: 'status', enableGraphs: true },
    },
  ]

  beforeEach(() => {
    saveMock.mockReset()
    saveMock.mockResolvedValue({ ok: true })
  })

  it("pre-selects the module's default with no override yet, and no revert button", () => {
    render(<ViewsSettings rows={defaultedRows} canEdit />)
    expect(screen.getByLabelText('Status field')).toHaveTextContent('Status')
    expect(screen.getByRole('switch', { name: 'Enable Graphs' })).toBeChecked()
    expect(screen.queryByRole('button', { name: 'Revert to module settings' })).not.toBeInTheDocument()
  })

  it('changing a field with a module default asks for confirmation before saving', async () => {
    render(<ViewsSettings rows={defaultedRows} canEdit />)
    await pickOption('Status field', 'Priority')

    expect(screen.getByText('Override the module default?')).toBeInTheDocument()
    expect(saveMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText('Override the module default?')).not.toBeInTheDocument())
    expect(saveMock).not.toHaveBeenCalled()
    // Cancelled: the select is still showing the module's own default.
    expect(screen.getByLabelText('Status field')).toHaveTextContent('Status')
  })

  it('confirming the override saves the new value and reveals the revert button', async () => {
    render(<ViewsSettings rows={defaultedRows} canEdit />)
    await pickOption('Status field', 'Priority')
    fireEvent.click(screen.getByRole('button', { name: 'Override anyway' }))

    await waitFor(() =>
      // Only the touched field becomes an override; enableGraphs (untouched)
      // stays null — still inheriting the module's default, not frozen to it.
      expect(saveMock).toHaveBeenCalledWith('crm', {
        kanbanStatusField: 'priority',
        calendarDateField: null,
        enableGraphs: null,
      }),
    )
    expect(await screen.findByRole('button', { name: 'Revert to module settings' })).toBeInTheDocument()
  })

  it('toggling Enable Graphs (also module-defaulted) warns the same way', async () => {
    render(<ViewsSettings rows={defaultedRows} canEdit />)
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Graphs' }))
    expect(screen.getByText('Override the module default?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Override anyway' }))
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith('crm', {
        kanbanStatusField: null,
        calendarDateField: null,
        enableGraphs: false,
      }),
    )
  })

  it('a field with NO module default applies immediately, no warning', async () => {
    render(<ViewsSettings rows={defaultedRows} canEdit />)
    await pickOption('Date field', 'Due date')
    expect(screen.queryByText('Override the module default?')).not.toBeInTheDocument()
    await waitFor(() => expect(saveMock).toHaveBeenCalled())
  })

  it('revert clears only the overridden fields the module actually defaults, restoring their value', async () => {
    const overriddenRows: ViewEntityRow[] = [
      {
        ...defaultedRows[0],
        config: { kanbanStatusField: 'priority', calendarDateField: 'due_date', enableGraphs: false },
      },
    ]
    render(<ViewsSettings rows={overriddenRows} canEdit />)

    fireEvent.click(screen.getByRole('button', { name: 'Revert to module settings' }))
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith('crm', {
        // calendar_date_field has no module default, so revert leaves it as
        // the admin set it — only kanban/graphs (both module-defaulted) clear.
        kanbanStatusField: null,
        calendarDateField: 'due_date',
        enableGraphs: null,
      }),
    )
    // Optimistically applied: the revert button disappears once no field is
    // overridden anymore relative to a module default.
    expect(screen.queryByRole('button', { name: 'Revert to module settings' })).not.toBeInTheDocument()
  })
})
