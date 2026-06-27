import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ViewDescriptor } from './descriptor'
import { EntityView } from './renderers'
import type { EntityActions } from './stores'

interface Contact {
  id: string
  name: string
  parent_id?: string | null
}

const noopActions: EntityActions<Contact> = {
  create: vi.fn(async (b) => ({ id: 'x', name: '', ...b }) as Contact),
  update: vi.fn(async (id, b) => ({ id, name: '', ...b }) as Contact),
}

const formDescriptor: ViewDescriptor<Contact> = {
  entity: 'crm',
  viewType: 'form',
  fields: [{ name: 'name', label: 'Name', type: 'text' }],
}

describe('EntityView', () => {
  it('renders an error alert with the code and request id, no renderer', () => {
    render(
      <EntityView
        descriptor={formDescriptor}
        initialData={[]}
        actions={noopActions}
        error={{ code: 'FORBIDDEN', message: 'nope', requestId: '01J-req' }}
      />,
    )
    expect(screen.getByText('FORBIDDEN')).toBeInTheDocument()
    expect(screen.getByText('nope')).toBeInTheDocument()
    expect(screen.getByText(/01J-req/)).toBeInTheDocument()
    // The form's Save button must not render when the view short-circuits to the error.
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('renders the form for viewType "form" with Save disabled until a field changes', () => {
    render(<EntityView descriptor={formDescriptor} initialData={[]} actions={noopActions} />)

    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada' } })
    expect(save).toBeEnabled()
  })

  it('offers Reset once dirty, and resetting re-disables Save', () => {
    render(<EntityView descriptor={formDescriptor} initialData={[]} actions={noopActions} />)

    const save = screen.getByRole('button', { name: 'Save' })
    const reset = screen.getByRole('button', { name: 'Reset' })
    expect(reset).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ada' } })
    expect(reset).toBeEnabled()
    expect(save).toBeEnabled()

    fireEvent.click(reset)
    expect(save).toBeDisabled()
    expect(reset).toBeDisabled()
  })

  it('renders a flat grid for a "tree" view with no hierarchy', () => {
    const treeDescriptor: ViewDescriptor<Contact> = { ...formDescriptor, viewType: 'tree' }
    render(
      <EntityView
        descriptor={treeDescriptor}
        initialData={[{ id: '1', name: 'Ada' }]}
        actions={noopActions}
      />,
    )
    expect(screen.getByRole('grid')).toBeInTheDocument()
    expect(screen.getByText('Ada')).toBeInTheDocument()
  })

  it('renders a hierarchical tree when records carry parent links', () => {
    const treeDescriptor: ViewDescriptor<Contact> = { ...formDescriptor, viewType: 'tree' }
    render(
      <EntityView
        descriptor={treeDescriptor}
        initialData={[
          { id: 'root', name: 'Root', parent_id: null },
          { id: 'child', name: 'Child', parent_id: 'root' },
        ]}
        actions={noopActions}
      />,
    )
    expect(screen.getByRole('tree')).toBeInTheDocument()
    expect(screen.getByText('Root')).toBeInTheDocument()
  })

  it('renders dashboard widget cards from the seed', () => {
    const dashDescriptor: ViewDescriptor<Contact> = { ...formDescriptor, viewType: 'dashboard' }
    render(
      <EntityView
        descriptor={dashDescriptor}
        initialData={[]}
        actions={noopActions}
        widgets={[{ id: 'w1', title: 'Pipeline' }]}
      />,
    )
    expect(screen.getByText('Pipeline')).toBeInTheDocument()
  })
})
