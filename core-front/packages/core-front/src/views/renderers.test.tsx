import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

// The flat list navigates to a record's form on row click via the App Router.
const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

import type { ViewDescriptor } from './descriptor'
import { CreateBar, EntityView } from './renderers'
import { useSessionStore, type Identity } from './session-store'
import type { EntityActions } from './stores'

function identityWith(permissions: string[]): Identity {
  return { userId: 'u1', tenantId: 't1', roles: ['tester'], permissions }
}

beforeEach(() => {
  pushMock.mockClear()
  useSessionStore.setState({ identity: null })
})

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

  it('an explicit layout groups/reorders the form — normalizeLayout drives it, not fields declaration order', () => {
    const laidOut: ViewDescriptor<Contact & { email: string }> = {
      entity: 'crm',
      viewType: 'form',
      // Declared name-then-email...
      fields: [
        { name: 'name', label: 'Name', type: 'text' },
        { name: 'email', label: 'Email', type: 'text' },
      ],
      // ...but the layout puts email first, inside a titled section.
      layout: [
        {
          kind: 'section',
          title: 'Contact',
          children: [{ kind: 'field', name: 'email' }, { kind: 'field', name: 'name' }],
        },
      ],
    }
    render(
      <EntityView
        descriptor={laidOut}
        initialData={[]}
        actions={noopActions as unknown as EntityActions<Contact & { email: string }>}
      />,
    )
    expect(screen.getByText('Contact')).toBeInTheDocument()
    const inputs = screen.getAllByRole('textbox')
    expect(inputs[0]).toBe(screen.getByLabelText('Email'))
    expect(inputs[1]).toBe(screen.getByLabelText('Name'))
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

  it('navigates to the record form on row click when the descriptor sets formPath', () => {
    const treeDescriptor: ViewDescriptor<Contact> = {
      ...formDescriptor,
      viewType: 'tree',
      formPath: '/crm/:id',
    }
    render(
      <EntityView
        descriptor={treeDescriptor}
        initialData={[{ id: '42', name: 'Ada' }]}
        actions={noopActions}
      />,
    )
    fireEvent.click(screen.getByText('Ada'))
    expect(pushMock).toHaveBeenCalledWith('/crm/42')
  })

  it('keeps rows inert when the descriptor has no formPath', () => {
    const treeDescriptor: ViewDescriptor<Contact> = { ...formDescriptor, viewType: 'tree' }
    render(
      <EntityView
        descriptor={treeDescriptor}
        initialData={[{ id: '42', name: 'Ada' }]}
        actions={noopActions}
      />,
    )
    fireEvent.click(screen.getByText('Ada'))
    expect(pushMock).not.toHaveBeenCalled()
  })

  describe('Create button', () => {
    const creatableList: ViewDescriptor<Contact> = {
      ...formDescriptor,
      viewType: 'tree',
      formPath: '/crm/:id',
      createPermission: 'crm:contacts:write',
    }

    it('is exported for the host title row and opens the empty form when granted', () => {
      useSessionStore.setState({ identity: identityWith(['crm:contacts:write']) })
      render(<CreateBar descriptor={creatableList} />)
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
      expect(pushMock).toHaveBeenCalledWith('/crm/new')
    })

    it('honors role wildcards from the session mirror', () => {
      useSessionStore.setState({ identity: identityWith(['*:*:*']) })
      render(<CreateBar descriptor={creatableList} />)
      expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument()
    })

    it('stays hidden when the session lacks the permission', () => {
      useSessionStore.setState({ identity: identityWith(['crm:contacts:read']) })
      render(<CreateBar descriptor={creatableList} />)
      expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument()
    })

    it('stays hidden when the descriptor declares no createPermission (default-closed)', () => {
      useSessionStore.setState({ identity: identityWith(['*:*:*']) })
      const readOnly: ViewDescriptor<Contact> = { ...creatableList, createPermission: undefined }
      render(<CreateBar descriptor={readOnly} />)
      expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument()
    })

    it('is NOT rendered by the tree view itself — the host owns its title-row placement', () => {
      useSessionStore.setState({ identity: identityWith(['*:*:*']) })
      render(
        <EntityView
          descriptor={creatableList}
          initialData={[{ id: '1', name: 'Ada' }]}
          actions={noopActions}
        />,
      )
      expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument()
    })

    it('is NOT rendered on dashboards — tree views only', () => {
      useSessionStore.setState({ identity: identityWith(['*:*:*']) })
      const dash: ViewDescriptor<Contact> = { ...creatableList, viewType: 'dashboard' }
      render(
        <EntityView
          descriptor={dash}
          initialData={[]}
          actions={noopActions}
          widgets={[{ id: 'w1', title: 'Contacts', href: '/crm/list', count: 1 }]}
        />,
      )
      expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument()
    })
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

  it('renders a dashboard block per list view with its name and entry count', () => {
    const dashDescriptor: ViewDescriptor<Contact> = { ...formDescriptor, viewType: 'dashboard' }
    render(
      <EntityView
        descriptor={dashDescriptor}
        initialData={[]}
        actions={noopActions}
        widgets={[{ id: 'w1', title: 'Contacts', href: '/crm/list', count: 12 }]}
      />,
    )
    expect(screen.getByText('Contacts')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    // The block links to its list view.
    expect(screen.getByRole('link')).toHaveAttribute('href', '/crm/list')
  })

  it('shows a dash for a dashboard block whose count failed to load', () => {
    const dashDescriptor: ViewDescriptor<Contact> = { ...formDescriptor, viewType: 'dashboard' }
    render(
      <EntityView
        descriptor={dashDescriptor}
        initialData={[]}
        actions={noopActions}
        widgets={[{ id: 'w1', title: 'Contacts', href: '/crm/list', count: null }]}
      />,
    )
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})
