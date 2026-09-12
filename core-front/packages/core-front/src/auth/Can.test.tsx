import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useSessionStore } from '../views/session-store'
import { Can } from './Can'

function seedPermissions(permissions: string[]) {
  useSessionStore.setState({
    identity: { userId: 'u1', tenantId: 't1', roles: [], permissions },
  })
}

afterEach(() => {
  useSessionStore.setState({ identity: null })
})

describe('<Can>', () => {
  it('renders children when the session grants the permission', () => {
    seedPermissions(['crm:contacts:write'])
    render(
      <Can permission="crm:contacts:write">
        <button>Save</button>
      </Can>,
    )
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('renders the fallback when the permission is missing', () => {
    seedPermissions(['crm:contacts:read'])
    render(
      <Can permission="crm:contacts:delete" fallback={<span>no access</span>}>
        <button>Delete</button>
      </Can>,
    )
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(screen.getByText('no access')).toBeInTheDocument()
  })

  it('denies when there is no identity', () => {
    render(
      <Can permission="crm:contacts:read">
        <button>View</button>
      </Can>,
    )
    expect(screen.queryByRole('button', { name: 'View' })).not.toBeInTheDocument()
  })
})
