import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import AppsList from './AppsList'

describe('AppsList', () => {
  it('renders one row per app, each linking to its settings form', () => {
    render(
      <AppsList
        apps={[
          { name: 'base', display_name: 'Base', description: 'Default settings', icon: '⚙️' },
          { name: 'crm', display_name: 'CRM', description: 'Customer records' },
        ]}
      />,
    )
    expect(screen.getByRole('link', { name: /base/i })).toHaveAttribute('href', '/settings/apps/base')
    expect(screen.getByRole('link', { name: /crm/i })).toHaveAttribute('href', '/settings/apps/crm')
    expect(screen.getByText('Default settings')).toBeInTheDocument()
    expect(screen.getByText('Customer records')).toBeInTheDocument()
  })

  it('falls back to the display name\'s first letter when no icon is given', () => {
    render(<AppsList apps={[{ name: 'crm', display_name: 'CRM' }]} />)
    expect(screen.getByText('C')).toBeInTheDocument()
  })

  it('shows the given icon when present', () => {
    render(<AppsList apps={[{ name: 'base', display_name: 'Base', icon: '⚙️' }]} />)
    expect(screen.getByText('⚙️')).toBeInTheDocument()
  })
})
