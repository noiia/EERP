import { expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/lib/site-session', () => ({ getSiteIdentity: async () => null }))
const authForm = vi.hoisted(() => vi.fn((props: { next?: string }) => (props ? null : null)))
vi.mock('@/website/SiteAuthForm', () => ({ SiteAuthForm: authForm }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

import SiteLoginPage from './page'

it('links staff to the ERP sign-in (old /login bookmarks land here)', async () => {
  render(await SiteLoginPage({ searchParams: Promise.resolve({}) }))
  expect(screen.getByRole('link', { name: 'Staff sign-in' }).getAttribute('href')).toBe('/app/login')
})

it('a repeated ?next= takes the first value instead of crashing', async () => {
  render(await SiteLoginPage({ searchParams: Promise.resolve({ next: ['/book', '/x'] }) }))
  expect(authForm.mock.calls.at(-1)![0].next).toBe('/book')
})
