import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ErrorAlert, errorDetails, splitMissingFields } from './error-alert'
import type { FieldDescriptor } from './descriptor'

const fields: FieldDescriptor[] = [
  { name: 'number', label: 'Number', type: 'text' },
  { name: 'customer_address', label: 'Billing address', type: 'address' },
]

describe('splitMissingFields', () => {
  it('names form fields by label, maps address sub-columns to their field, keeps the rest apart', () => {
    expect(
      splitMissingFields(['number', 'customer_address_city', 'customer_address_zip_code', 'issuer_name'], fields),
    ).toEqual({ onForm: ['Number', 'Billing address'], offForm: ['issuer_name'] })
  })
})

describe('ErrorAlert', () => {
  const validation = {
    code: 'VALIDATION_ERROR',
    message: 'missing required fields: number, issuer_name',
    requestId: 'req-42',
    fields: ['number', 'issuer_name'],
  }

  it('tells the user what to fill and what to send to an administrator', () => {
    render(<ErrorAlert error={validation} fields={fields} />)
    expect(screen.getByText('Required fields are missing')).toBeInTheDocument()
    expect(screen.getByText(/Fill in/)).toHaveTextContent('Fill in: Number')
    expect(screen.getByText(/not on this form/)).toHaveTextContent('issuer_name')
    expect(screen.getByText(/Reference for your administrator/)).toHaveTextContent('req-42')
    expect(screen.getByRole('button', { name: 'Copy details' })).toBeInTheDocument()
  })

  it('falls back to code + message for any other error', () => {
    render(<ErrorAlert error={{ code: 'FORBIDDEN', message: 'Missing permission' }} />)
    expect(screen.getByText('FORBIDDEN')).toBeInTheDocument()
    expect(screen.getByText('Missing permission')).toBeInTheDocument()
  })

  it('copy details carries everything an administrator needs', () => {
    const text = errorDetails(validation)
    expect(text).toContain('code: VALIDATION_ERROR')
    expect(text).toContain('fields: number, issuer_name')
    expect(text).toContain('request id: req-42')
  })
})
