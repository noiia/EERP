import { expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('@/lib/website-settings', () => ({ saveRouting: async () => ({ ok: false, message: '' }) }))

import RoutingForm from './RoutingForm'

it('shows the translated fallback when the save failed without a server message', async () => {
  render(<RoutingForm initial={{ mode: 'path', site_host: '', erp_host: '' }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('Could not save.')).toBeTruthy()
})
