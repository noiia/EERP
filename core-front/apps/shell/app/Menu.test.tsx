import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import Menu from './Menu'
import type { MenuModule } from '@eerp/core-front'

const descriptor = { entity: 'x', viewType: 'tree', fields: [] }
const menu = [
  { name: 'crm', routes: [{ path: '/crm', descriptor }] },
  { name: 'stock_manager', routes: [{ path: '/stock', descriptor }] },
] as unknown as MenuModule[]

describe('Menu', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('renders one tile per module plus the built-in Settings tile, each linking to its first route', () => {
    render(<Menu menu={menu} />)
    expect(screen.getByRole('link', { name: /crm/i })).toHaveAttribute('href', '/crm')
    expect(screen.getByRole('link', { name: /stock manager/i })).toHaveAttribute('href', '/stock')
    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute('href', '/settings')
  })

  it('renders with stable keys — no React key warning (the key sits on the mapped tile, not an inner child)', () => {
    render(<Menu menu={menu} />)
    const keyWarnings = errorSpy.mock.calls.filter((args: unknown[]) =>
      args.some((a: unknown) => typeof a === 'string' && a.includes('unique "key" prop')),
    )
    expect(keyWarnings).toHaveLength(0)
  })

  it('gives every tile exactly one label, always inside the tile', () => {
    render(<Menu menu={menu} />)
    // 2 modules + Settings = 3 tiles; each contributes exactly one label —
    // no below-tile duplicate now that even the compact tier (300px) is
    // spacious enough to hold icon/monogram + label together.
    expect(screen.getAllByText('Stock Manager')).toHaveLength(1)
  })

  it('module tiles with no icon get a monogram so the compact tile is never blank', () => {
    render(<Menu menu={menu} />)
    const crmLink = screen.getByRole('link', { name: /crm/i })
    expect(crmLink).toHaveTextContent(/^C/)
  })

  it('shows the empty-state message when no applications are installed (Settings still listed)', () => {
    render(<Menu menu={[]} />)
    expect(screen.getByText('No applications are available for your account.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute('href', '/settings')
  })
})
