import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { MenuModule } from '@eerp/core-front'
import Menu from './Menu'

// HomePage itself is an async, auth-gated Server Component (redirects anon users to
// /login and reads the registry/session). Its rendering surface is the pure <Menu>
// component, which is what we unit-test here; the redirect path is covered by the
// requireAuth guard (lib/session) and the catch-all route's own tests.

const descriptor = {
  entity: 'crm',
  viewType: 'tree' as const,
  fields: [{ name: 'name', label: 'Name', type: 'text' as const }],
}

const menu: MenuModule[] = [
  {
    name: 'crm',
    routes: [{ path: '/crm/contacts', descriptor, permission: 'crm:contacts:read' }],
  },
]

describe('Menu', () => {
  it('lists installed applications and their views as links', () => {
    render(<Menu menu={menu} userId="user-1" />)

    expect(screen.getByRole('heading', { name: 'Applications' })).toBeInTheDocument()
    expect(screen.getByText('Signed in as user-1')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Crm' })).toBeInTheDocument()

    const link = screen.getByRole('link', { name: /contacts/i })
    expect(link).toHaveAttribute('href', '/crm/contacts')
  })

  it('shows an empty-state message when no application is available', () => {
    render(<Menu menu={[]} userId="user-1" />)
    expect(screen.getByText(/no applications are available/i)).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
