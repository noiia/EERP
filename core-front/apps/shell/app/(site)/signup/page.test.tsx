import { expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'

vi.mock('@/lib/site-session', () => ({ getSiteIdentity: async () => null }))
const authForm = vi.hoisted(() => vi.fn((props: { next?: string }) => (props ? null : null)))
vi.mock('@/website/SiteAuthForm', () => ({ SiteAuthForm: authForm }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

import SiteSignupPage from './page'

it('a repeated ?next= takes the first value instead of crashing', async () => {
  render(await SiteSignupPage({ searchParams: Promise.resolve({ next: ['/book', '/x'] }) }))
  expect(authForm.mock.calls.at(-1)![0].next).toBe('/book')
})

it('passes a single ?next= through', async () => {
  render(await SiteSignupPage({ searchParams: Promise.resolve({ next: '/book' }) }))
  expect(authForm.mock.calls.at(-1)![0].next).toBe('/book')
})
