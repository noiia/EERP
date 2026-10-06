import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const { saveMailTemplate, resetMailTemplate } = vi.hoisted(() => ({
  saveMailTemplate: vi.fn<(...args: unknown[]) => Promise<{ ok: true } | { ok: false; message: string }>>(async () => ({ ok: true })),
  resetMailTemplate: vi.fn<(...args: unknown[]) => Promise<{ ok: true }>>(async () => ({ ok: true })),
}))
vi.mock('@/lib/mail-templates', () => ({ saveMailTemplate, resetMailTemplate }))

import EmailTemplatesForm from './EmailTemplatesForm'
import type { MailTemplate } from '@/lib/mail-templates'

afterEach(() => vi.clearAllMocks())

const templates: MailTemplate[] = [
  {
    key: 'event.booking_confirmed', label: 'Event booking confirmed', vars: ['name', 'event'],
    defaults: { en: { subject: 'Booking confirmed: {{event}}', html: '<p>Hello {{name}}</p>' }, fr: { subject: 'Réservation confirmée', html: '<p>Bonjour</p>' } },
    overrides: {},
  },
  {
    key: 'website.verify_email', label: 'Website: confirm your email', vars: ['verify_url'],
    defaults: { en: { subject: 'Confirm your email', html: '<p>Confirm</p>' } },
    overrides: { en: { subject: 'Please confirm', html: '<p>Custom</p>' } },
  },
]

const subject = () => screen.getByLabelText('Subject') as HTMLInputElement

describe('EmailTemplatesForm', () => {
  it('shows the default text and saves an override', async () => {
    render(<EmailTemplatesForm templates={templates} canEdit />)
    expect(subject().value).toBe('Booking confirmed: {{event}}')
    expect(screen.getByText('Default text')).toBeTruthy()
    fireEvent.change(subject(), { target: { value: 'Booked: {{event}}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saveMailTemplate).toHaveBeenCalled())
    expect(saveMailTemplate.mock.calls[0]).toEqual(['event.booking_confirmed', 'en', { subject: 'Booked: {{event}}', html: '<p>Hello {{name}}</p>' }])
    expect(await screen.findByText('Customized')).toBeTruthy()
  })

  it('switches language and offers the variables as chips', async () => {
    render(<EmailTemplatesForm templates={templates} canEdit />)
    fireEvent.mouseDown(screen.getByLabelText('Language'))
    fireEvent.click(within(screen.getByRole('listbox')).getByText('fr'))
    expect(subject().value).toBe('Réservation confirmée')
    expect(await screen.findByRole('button', { name: '{{name}}' })).toBeTruthy()
  })

  it('resets a customized template to its default', async () => {
    render(<EmailTemplatesForm templates={templates} canEdit />)
    fireEvent.mouseDown(screen.getByLabelText('Email'))
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Website: confirm your email'))
    expect(subject().value).toBe('Please confirm')
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))
    await waitFor(() => expect(resetMailTemplate).toHaveBeenCalledWith('website.verify_email', 'en'))
    await waitFor(() => expect(subject().value).toBe('Confirm your email'))
  })

  it("shows Go's refusal", async () => {
    saveMailTemplate.mockResolvedValueOnce({ ok: false, message: 'unknown variable {{x}}' })
    render(<EmailTemplatesForm templates={templates} canEdit />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('unknown variable {{x}}')).toBeTruthy()
  })

  it('is read-only without the write permission', () => {
    render(<EmailTemplatesForm templates={templates} canEdit={false} />)
    expect(subject().disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })
})
