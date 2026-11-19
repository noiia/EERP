import { describe, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TokenActionForm } from './TokenActionForm'
import type { TokenResult } from './booking-actions'

describe('TokenActionForm', () => {
  it('posts the token on click and shows the outcome', async () => {
    const action = vi.fn(async (_p: TokenResult, f: FormData): Promise<TokenResult> => (f.get('token') === 'good' ? 'ok' : 'invalid'))
    const { unmount } = render(<TokenActionForm action={action} token="good" button="Cancel booking" done="Your booking is cancelled." />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }))
    await screen.findByText('Your booking is cancelled.')
    unmount()

    render(<TokenActionForm action={action} token="bad" button="Cancel booking" done="Your booking is cancelled." />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }))
    await screen.findByText(/invalid or was already used/)
  })

  it('says the seat was taken when a claim lost the race', async () => {
    const action = vi.fn(async (): Promise<TokenResult> => 'taken')
    render(<TokenActionForm action={action} token="t" button="Book my seat" done="Your seat is booked." />)
    fireEvent.click(screen.getByRole('button', { name: 'Book my seat' }))
    await screen.findByText(/someone booked this seat first/i)
  })
})
