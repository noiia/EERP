import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { decideAuthorization } = vi.hoisted(() => ({ decideAuthorization: vi.fn() }))
vi.mock('@/lib/mcp-oauth', () => ({ decideAuthorization }))

import OAuthConsent from './OAuthConsent'

const params = { client_id: 'https://claude.ai/c', redirect_uri: 'https://claude.ai/cb' }
const check = { ok: true as const, client_id: params.client_id, client_name: 'Claude', client_host: 'claude.ai', redirect_uri: params.redirect_uri }
const assign = vi.fn()

beforeEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } })
})
afterEach(() => vi.clearAllMocks())

it('names the app and its host, and sends the user back with the code on Allow', async () => {
  decideAuthorization.mockResolvedValue({ ok: true, redirect_to: 'https://claude.ai/cb?code=c' })
  render(<OAuthConsent check={check} params={params} />)
  expect(screen.getByRole('heading', { name: 'Connect Claude?' })).toBeTruthy()
  expect(screen.getByText(/Request from claude\.ai/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
  await waitFor(() => expect(assign).toHaveBeenCalledWith('https://claude.ai/cb?code=c'))
  expect(decideAuthorization).toHaveBeenCalledWith(params, true)
})

it('denies, and never leaves for a non-https URL', async () => {
  decideAuthorization.mockResolvedValue({ ok: true, redirect_to: 'javascript:alert(1)' })
  render(<OAuthConsent check={check} params={params} />)
  fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
  await waitFor(() => expect(decideAuthorization).toHaveBeenCalledWith(params, false))
  expect(assign).not.toHaveBeenCalled()
})

it('shows a refusal, with a way back only when Go allows one', async () => {
  decideAuthorization.mockResolvedValue({ ok: false, error: 'access_denied', error_description: 'Change your password in EERP first.' })
  render(<OAuthConsent check={check} params={params} />)
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
  expect(await screen.findByText('Change your password in EERP first.')).toBeTruthy()

  render(<OAuthConsent check={{ ok: false, error: 'invalid_request', error_description: 'PKCE required', redirect_to: 'https://claude.ai/cb?error=x' }} params={params} />)
  fireEvent.click(screen.getByRole('button', { name: 'Return to the application' }))
  expect(assign).toHaveBeenCalledWith('https://claude.ai/cb?error=x')
})

it('says so when OAuth is off or EERP is unreachable', async () => {
  render(<OAuthConsent check={null} params={params} />)
  expect(screen.getByText('Connecting apps to EERP is not enabled on this server.')).toBeTruthy()
})

it('reports an unreachable EERP after Allow', async () => {
  decideAuthorization.mockResolvedValue(null)
  render(<OAuthConsent check={check} params={params} />)
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
  expect(await screen.findByText('EERP could not be reached. Try again.')).toBeTruthy()
})
