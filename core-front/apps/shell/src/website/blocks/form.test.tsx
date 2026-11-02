import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const pushMock = vi.fn()
const refreshMock = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock, refresh: refreshMock }) }))
const identity = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('@/lib/site-session', () => ({ getSiteIdentity: async () => identity.value }))
const account = vi.hoisted(() => ({ me: null as unknown, contact: null as unknown }))
vi.mock('../account', () => ({ getWebsiteMe: async () => account.me, getMyContact: async () => account.contact }))

import { SiteForm } from './SiteForm'
import { FormBlock } from './FormBlock'
import type { FormConfig } from '../types'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const config = (patch: Partial<FormConfig> = {}): FormConfig => ({
  targets: [{ table: 'contact' }],
  fields: [
    { id: 'name', label: 'Name', type: 'text', column: 'name', required: true, target: 0 },
    { id: 'email', label: 'Email', type: 'email', column: 'email', required: true, target: 0 },
  ],
  after: { kind: 'message', message: 'Thanks, we got it!' },
  ...patch,
})

function fill() {
  fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'Vi' } })
  fireEvent.change(screen.getByLabelText(/^email/i), { target: { value: 'v@x.io' } })
}

beforeEach(() => {
  identity.value = null
  account.me = null
  account.contact = null
})
afterEach(() => {
  vi.unstubAllGlobals()
  pushMock.mockClear()
  refreshMock.mockClear()
})

describe('SiteForm', () => {
  it('a required empty field blocks the submit with a field error', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    render(<SiteForm pageId="p1" blockId="b1" config={config()} />)
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    expect((await screen.findAllByText(/this field is required/i)).length).toBe(2)
    expect(f).not.toHaveBeenCalled()
  })

  it('posts the values and shows the configured message', async () => {
    const f = vi.fn(async () => json(201, { ok: true }))
    vi.stubGlobal('fetch', f)
    render(<SiteForm pageId="p1" blockId="b1" config={config()} />)
    fill()
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    await screen.findByText('Thanks, we got it!')
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('/api/site-forms/p1/b1')
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ values: { name: 'Vi', email: 'v@x.io' } })
  })

  it('goes to the configured page after a submit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(201, { ok: true })))
    render(<SiteForm pageId="p1" blockId="b1" config={config({ after: { kind: 'page', slug: 'thanks' } })} />)
    fill()
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/thanks'))
  })

  it('a 422 marks the fields Go names', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(422, { error: { code: 'VALIDATION_ERROR', message: 'x', fields: ['email'] } })))
    render(<SiteForm pageId="p1" blockId="b1" config={config()} />)
    fill()
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(await screen.findByText(/check this value/i)).toBeTruthy()
  })

  it('creating an account signs up first, then submits', async () => {
    const f = vi.fn(async (url: string) => (url === '/api/site-auth/signup' ? json(200, { identity: {} }) : json(201, { ok: true })))
    vi.stubGlobal('fetch', f)
    render(<SiteForm pageId="p1" blockId="b1" config={config({ allow_signup: true })} />)
    fill()
    fireEvent.click(screen.getByLabelText(/create an account/i))
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    await screen.findByText('Thanks, we got it!')
    expect(f.mock.calls.map((c) => c[0])).toEqual(['/api/site-auth/signup', '/api/site-forms/p1/b1'])
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ email: 'v@x.io', password: 'secret123', name: 'Vi' })
  })

  it('an email that already has an account is a field error, and nothing is submitted', async () => {
    const f = vi.fn(async () => json(409, { error: { code: 'CONFLICT', message: 'taken' } }))
    vi.stubGlobal('fetch', f)
    render(<SiteForm pageId="p1" blockId="b1" config={config({ allow_signup: true })} />)
    fill()
    fireEvent.click(screen.getByLabelText(/create an account/i))
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(await screen.findByText(/already has an account/i)).toBeTruthy()
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('FormBlock', () => {
  it('login required and anonymous: a login button and a sign-up link back to this page', async () => {
    render(await FormBlock({ config: config({ login_required: true }), pageId: 'p1', blockId: 'b1', path: '/book' }))
    expect(screen.getByRole('link', { name: /log in to continue/i }).getAttribute('href')).toBe('/login?next=%2Fbook')
    expect(screen.getByRole('link', { name: /sign up/i }).getAttribute('href')).toBe('/signup?next=%2Fbook')
    expect(screen.queryByRole('button', { name: /send/i })).toBeNull()
  })

  it('after login goes to the configured page when set', async () => {
    render(await FormBlock({ config: config({ login_required: true, after_login_slug: 'members' }), pageId: 'p1', blockId: 'b1', path: '/book' }))
    expect(screen.getByRole('link', { name: /log in to continue/i }).getAttribute('href')).toBe('/login?next=%2Fmembers')
  })

  it('signed in: prefills from the website contact, then the account; the email is read-only', async () => {
    identity.value = { userId: 'u' }
    account.contact = { name: 'Contact name', surname: null, email: 'v@x.io', phone: null }
    account.me = { name: 'Account name', surname: 'Doe', email: 'v@x.io', phone: '0600', email_verified: true }
    const cfg = config({
      login_required: true,
      fields: [
        ...config().fields,
        { id: 'surname', label: 'Surname', type: 'text', column: 'surname', target: 0 },
        { id: 'phone', label: 'Phone', type: 'phone', column: 'phone', target: 0 },
      ],
    })
    render(await FormBlock({ config: cfg, pageId: 'p1', blockId: 'b1', path: '/book' }))
    expect((screen.getByLabelText(/^name/i) as HTMLInputElement).value).toBe('Contact name')
    expect((screen.getByLabelText(/^surname/i) as HTMLInputElement).value).toBe('Doe')
    expect((screen.getByLabelText(/^phone/i) as HTMLInputElement).value).toBe('0600')
    const email = screen.getByLabelText(/^email/i) as HTMLInputElement
    expect(email.value).toBe('v@x.io')
    expect(email.readOnly).toBe(true)
    expect(screen.queryByLabelText(/create an account/i)).toBeNull()
  })
})
