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
  it('renders one tile per installed application, linking to its first view', () => {
    render(<Menu menu={menu} />)

    // The application is "crm" — one tile labeled by the app, linking to its first route.
    const app = screen.getByRole('link', { name: 'Crm' })
    expect(app).toHaveAttribute('href', '/crm/contacts')

    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute('href', '/settings')
  })

  it('shows an empty-state message when no application is available', () => {
    render(<Menu menu={[]} />)
    expect(screen.getByText(/no applications are available/i)).toBeInTheDocument()
    // The Settings tile is always present; no application tiles are.
    expect(screen.queryByRole('link', { name: 'Crm' })).not.toBeInTheDocument()
  })
})
