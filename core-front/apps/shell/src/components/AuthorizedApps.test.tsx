import { afterEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { revokeAuthorizedApp } = vi.hoisted(() => ({ revokeAuthorizedApp: vi.fn() }))
vi.mock('@/lib/mcp-oauth', () => ({ revokeAuthorizedApp }))

import AuthorizedApps from './AuthorizedApps'

const apps = [
  { id: 'g1', client_name: 'Claude', client_id: 'https://claude.ai/c', created_at: '2026-11-20T10:00:00Z', last_used_at: null },
  { id: 'g2', client_name: 'ChatGPT', client_id: 'eerp-x', created_at: '2026-11-19T10:00:00Z', last_used_at: '2026-11-20T10:00:00Z' },
]
afterEach(() => vi.clearAllMocks())

it('lists the apps and revokes one', async () => {
  revokeAuthorizedApp.mockResolvedValue(true)
  render(<AuthorizedApps apps={apps} />)
  expect(screen.getByText('Claude')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Revoke Claude' }))
  await waitFor(() => expect(screen.queryByText('Claude')).toBeNull())
  expect(revokeAuthorizedApp).toHaveBeenCalledWith('g1')
  expect(screen.getByText('ChatGPT')).toBeTruthy()
})

it('keeps the app and says so when the revoke fails', async () => {
  revokeAuthorizedApp.mockResolvedValue(false)
  render(<AuthorizedApps apps={apps} />)
  fireEvent.click(screen.getByRole('button', { name: 'Revoke ChatGPT' }))
  expect(await screen.findByText('Could not save.')).toBeTruthy()
  expect(screen.getByText('ChatGPT')).toBeTruthy()
})

it('says when no app is connected', () => {
  render(<AuthorizedApps apps={[]} />)
  expect(screen.getByText('No app is connected.')).toBeTruthy()
})
