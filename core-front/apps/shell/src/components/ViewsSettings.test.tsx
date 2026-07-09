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
  },
]

describe('ViewsSettings', () => {
  beforeEach(() => {
    saveMock.mockReset()
    saveMock.mockResolvedValue({ ok: true })
  })

  it('lists each tree-view entity with its selection/date fields as choices', () => {
    render(<ViewsSettings rows={rows} canEdit />)
    expect(screen.getByText('crm')).toBeInTheDocument()
    expect(screen.getByLabelText('Status field')).toBeInTheDocument()
    expect(screen.getByLabelText('Date field')).toBeInTheDocument()
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
