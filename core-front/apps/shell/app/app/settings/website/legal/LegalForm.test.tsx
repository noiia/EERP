import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const saveLegal = vi.fn()
vi.mock('@/lib/website-settings', () => ({ saveLegal: (...a: unknown[]) => saveLegal(...a) }))

import LegalForm from './LegalForm'
import type { LegalNotice } from '@/lib/website-settings'

const empty: LegalNotice = {
  company_name: '', legal_form: '', share_capital: '', address: '', registration: '', vat_number: '',
  publication_director: '', contact_email: '', contact_phone: '', host_name: '', host_address: '', host_phone: '', extra_text: '',
}

beforeEach(() => saveLegal.mockReset())

it('edits the publisher, the host and the free text, then saves them', async () => {
  saveLegal.mockResolvedValue({ ok: true })
  render(<LegalForm initial={empty} />)
  fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Acme' } })
  fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'OVH' } })
  fireEvent.change(screen.getByLabelText('Additional text (privacy, cookies, credits…)'), { target: { value: 'No cookies.' } })
  expect(screen.getByRole('link', { name: 'View on the website' }).getAttribute('href')).toBe('/legal-notice')
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('Saved.')).toBeTruthy()
  expect(saveLegal).toHaveBeenCalledWith({ ...empty, company_name: 'Acme', host_name: 'OVH', extra_text: 'No cookies.' })
})

it('shows Go\'s refusal, else its own fallback', async () => {
  saveLegal.mockResolvedValueOnce({ ok: false, message: 'too long' }).mockResolvedValueOnce({ ok: false, message: '' })
  render(<LegalForm initial={empty} />)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('too long')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('Could not save.')).toBeTruthy()
})
