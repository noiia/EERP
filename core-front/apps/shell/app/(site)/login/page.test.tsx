import { expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/lib/site-session', () => ({ getSiteIdentity: async () => null }))
vi.mock('@/website/SiteAuthForm', () => ({ SiteAuthForm: () => null }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

import SiteLoginPage from './page'

it('links staff to the ERP sign-in (old /login bookmarks land here)', async () => {
  render(await SiteLoginPage({ searchParams: Promise.resolve({}) }))
  expect(screen.getByRole('link', { name: 'Staff sign-in' }).getAttribute('href')).toBe('/app/login')
})
