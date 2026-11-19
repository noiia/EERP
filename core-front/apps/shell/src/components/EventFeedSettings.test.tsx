import { afterEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { createMyEventFeed, revokeMyEventFeed } = vi.hoisted(() => ({
  createMyEventFeed: vi.fn(async () => ({ ok: true as const, path: '/api/v1/calendar/abc.ics' })),
  revokeMyEventFeed: vi.fn(async () => true),
}))
vi.mock('@/lib/event-settings', () => ({ createMyEventFeed, revokeMyEventFeed }))

import EventFeedSettings from './EventFeedSettings'

afterEach(() => vi.clearAllMocks())

it('creates a link and shows it once, absolute', async () => {
  render(<EventFeedSettings enabled={false} />)
  fireEvent.click(screen.getByRole('button', { name: 'Create my calendar link' }))
  const field = (await screen.findByLabelText('Calendar link')) as HTMLInputElement
  expect(field.value).toBe(`${window.location.origin}/api/v1/calendar/abc.ics`)
})

it('replaces or revokes an existing link', async () => {
  render(<EventFeedSettings enabled />)
  expect(screen.getByRole('button', { name: 'Replace my calendar link' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Stop the link' }))
  await waitFor(() => expect(revokeMyEventFeed).toHaveBeenCalled())
  expect(await screen.findByRole('button', { name: 'Create my calendar link' })).toBeTruthy()
})
