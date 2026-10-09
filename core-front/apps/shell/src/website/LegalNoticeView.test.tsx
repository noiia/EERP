import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LegalNoticeView } from './LegalNoticeView'

const empty = {
  company_name: '',
  legal_form: '',
  share_capital: '',
  address: '',
  registration: '',
  vat_number: '',
  publication_director: '',
  contact_email: '',
  contact_phone: '',
  host_name: '',
  host_address: '',
  host_phone: '',
  extra_text: '',
}

describe('LegalNoticeView', () => {
  it('shows only the filled fields, as text', () => {
    render(
      <LegalNoticeView
        legal={{
          ...empty,
          company_name: 'Acme SAS',
          contact_email: 'legal@acme.fr',
          extra_text: '<b>not html</b>',
        }}
      />,
    )
    expect(screen.getByText('Acme SAS')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'legal@acme.fr' }).getAttribute('href')).toBe(
      'mailto:legal@acme.fr',
    )
    expect(screen.getByText('<b>not html</b>')).toBeTruthy()
    expect(screen.queryByText('Hosting')).toBeNull() // an empty section is hidden
    expect(screen.queryByText('Legal form')).toBeNull()
  })
})
