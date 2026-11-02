import { expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'

const identity = vi.hoisted(() => ({ value: null as null | object }))
vi.mock('@/lib/site-session', () => ({ getSiteIdentity: async () => identity.value }))
const authForm = vi.hoisted(() => vi.fn((props: { next?: string }) => (props ? null : null)))
vi.mock('@/website/SiteAuthForm', () => ({ SiteAuthForm: authForm }))
const redirect = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ redirect }))

import SiteSignupPage from './page'

it('a repeated ?next= takes the first value instead of crashing', async () => {
  render(await SiteSignupPage({ searchParams: Promise.resolve({ next: ['/book', '/x'] }) }))
  expect(authForm.mock.calls.at(-1)![0].next).toBe('/book')
})

it('passes a single ?next= through', async () => {
  render(await SiteSignupPage({ searchParams: Promise.resolve({ next: '/book' }) }))
  expect(authForm.mock.calls.at(-1)![0].next).toBe('/book')
})

it('a signed-in visitor follows a safe ?next=', async () => {
  identity.value = {}
  redirect.mockClear()
  await SiteSignupPage({ searchParams: Promise.resolve({ next: '/book' }) })
  expect(redirect).toHaveBeenCalledWith('/book')
  identity.value = null
})

it.each(['//evil', '/app'])('a signed-in visitor with unsafe ?next=%s goes to the account', async (bad) => {
  identity.value = {}
  redirect.mockClear()
  await SiteSignupPage({ searchParams: Promise.resolve({ next: bad }) })
  expect(redirect).toHaveBeenCalledWith('/account')
  identity.value = null
})
