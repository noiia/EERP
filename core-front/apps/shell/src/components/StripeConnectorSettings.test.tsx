import { afterEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const { saveStripeSettings } = vi.hoisted(() => ({
  saveStripeSettings: vi.fn<(...a: unknown[]) => Promise<{ ok: true } | { ok: false; message: string }>>(async () => ({ ok: true })),
}))
vi.mock('@/lib/stripe-settings', () => ({ saveStripeSettings }))

import StripeConnectorSettings from './StripeConnectorSettings'

afterEach(() => vi.clearAllMocks())
const off = { enabled: false, secret_key_set: false, webhook_secret_set: false, active: true }

it('saves the keys without ever showing saved ones', async () => {
  render(<StripeConnectorSettings canEdit initial={{ ...off, secret_key_set: true }} webhookURL="https://site/api/v1/public/payments/payment_stripe/webhook" />)
  expect((screen.getByLabelText(/secret key/i) as HTMLInputElement).value).toBe('')
  expect(screen.getByText(/a secret key is saved/i)).toBeTruthy()
  expect(screen.getByText('https://site/api/v1/public/payments/payment_stripe/webhook')).toBeTruthy()
  fireEvent.click(screen.getByLabelText('Take payments online'))
  fireEvent.change(screen.getByLabelText(/webhook signing secret/i), { target: { value: 'whsec_1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(saveStripeSettings).toHaveBeenCalledWith({ enabled: true, secret_key: '', webhook_secret: 'whsec_1' }))
})

it('warns when the module is off and shows refusals', async () => {
  saveStripeSettings.mockResolvedValueOnce({ ok: false, message: 'the secret key starts with sk_' })
  render(<StripeConnectorSettings canEdit initial={{ ...off, active: false }} webhookURL="u" />)
  expect(screen.getByText(/activate the stripe payments app/i)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('the secret key starts with sk_')).toBeTruthy()
})
