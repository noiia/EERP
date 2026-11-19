import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const saveSecurityTxt = vi.fn()
const previewSiteFile = vi.fn()
vi.mock('@/lib/website-settings', () => ({
  saveSecurityTxt: (...a: unknown[]) => saveSecurityTxt(...a),
  previewSiteFile: (...a: unknown[]) => previewSiteFile(...a),
}))

import SecurityTxtForm from './SecurityTxtForm'
import type { SecurityTxt } from '@/lib/website-settings'

const empty: SecurityTxt = { contacts: [], expires: '', policy: '', acknowledgments: '', encryption: '', preferred_languages: '' }

beforeEach(() => {
  saveSecurityTxt.mockReset()
  previewSiteFile.mockReset().mockResolvedValue('')
})

it('says the file is not served until it has contacts', async () => {
  render(<SecurityTxtForm initial={empty} />)
  expect(await screen.findByText('Not served.')).toBeTruthy()
  expect((screen.getByLabelText('Expires') as HTMLInputElement).value).toBe('')
})

it('edits every field, saves RFC 3339 expiry and refreshes the preview', async () => {
  saveSecurityTxt.mockResolvedValue({ ok: true })
  previewSiteFile.mockResolvedValueOnce('').mockResolvedValueOnce('Contact: mailto:sec@acme.fr')
  render(<SecurityTxtForm initial={{ ...empty, expires: '2027-01-01T00:00:00Z' }} />)
  expect((screen.getByLabelText('Expires') as HTMLInputElement).value).toMatch(/^202[67]-/)

  fireEvent.change(screen.getByLabelText('Contacts (one per line)'), { target: { value: 'mailto:sec@acme.fr\ntel:+33100000000' } })
  fireEvent.change(screen.getByLabelText('Expires'), { target: { value: '2027-06-01T12:00' } })
  fireEvent.change(screen.getByLabelText('Policy URL'), { target: { value: 'https://acme.fr/p' } })
  fireEvent.change(screen.getByLabelText('Acknowledgments URL'), { target: { value: 'https://acme.fr/a' } })
  fireEvent.change(screen.getByLabelText('Encryption key URL'), { target: { value: 'https://acme.fr/k' } })
  fireEvent.change(screen.getByLabelText('Preferred languages'), { target: { value: 'fr, en' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))

  expect(await screen.findByText('Saved.')).toBeTruthy()
  const saved = saveSecurityTxt.mock.calls[0][0] as SecurityTxt
  expect(saved).toMatchObject({ contacts: ['mailto:sec@acme.fr', 'tel:+33100000000'], policy: 'https://acme.fr/p', acknowledgments: 'https://acme.fr/a', encryption: 'https://acme.fr/k', preferred_languages: 'fr, en' })
  expect(saved.expires).toMatch(/^2027-06-01T\d{2}:00:00Z$/)
  expect(await screen.findByText('Contact: mailto:sec@acme.fr')).toBeTruthy()
})

it('clears the expiry, and shows Go\'s refusal (or its own fallback) without re-reading the file', async () => {
  saveSecurityTxt.mockResolvedValueOnce({ ok: false, message: 'expires is in the past' }).mockResolvedValueOnce({ ok: false, message: '' })
  const { unmount } = render(<SecurityTxtForm initial={{ ...empty, expires: 'not a date' }} />)
  expect((screen.getByLabelText('Expires') as HTMLInputElement).value).toBe('')
  unmount()
  render(<SecurityTxtForm initial={{ ...empty, expires: '2027-01-01T00:00:00Z' }} />)
  fireEvent.change(screen.getByLabelText('Expires'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('expires is in the past')).toBeTruthy()
  expect(saveSecurityTxt.mock.calls[0][0].expires).toBe('')
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByText('Could not save.')).toBeTruthy()
  expect(previewSiteFile).toHaveBeenCalledTimes(2) // one per mount, none after a refused save
})
