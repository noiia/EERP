import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TaxSettings as TaxSettingsValue } from '@/lib/tax-settings'

// The save is a Server Action; the component only sees its result object.
const saveMock = vi.fn()
vi.mock('@/lib/tax-settings', () => ({
  setTaxSettings: (settings: TaxSettingsValue) => saveMock(settings),
}))

import TaxSettings from './TaxSettings'

const excluded: TaxSettingsValue = { price_mode: 'tax_excluded' }

beforeEach(() => {
  saveMock.mockReset()
  saveMock.mockResolvedValue({ ok: true })
})

describe('TaxSettings', () => {
  it('shows the stored price mode', () => {
    render(<TaxSettings canEdit initialSettings={{ price_mode: 'tax_included' }} />)
    expect(screen.getByLabelText(/tax already included in the price/i)).toBeChecked()
    expect(screen.getByLabelText(/tax computed on top of the price/i)).not.toBeChecked()
  })

  it('saves immediately when the mode is switched', async () => {
    render(<TaxSettings canEdit initialSettings={excluded} />)
    fireEvent.click(screen.getByLabelText(/tax already included in the price/i))
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith({ price_mode: 'tax_included' }))
  })

  it('surfaces the error message on a failed save', async () => {
    saveMock.mockResolvedValue({ ok: false, message: 'Missing permission settings:tax:write' })
    render(<TaxSettings canEdit initialSettings={excluded} />)
    fireEvent.click(screen.getByLabelText(/tax already included in the price/i))
    expect(await screen.findByText('Missing permission settings:tax:write')).toBeInTheDocument()
  })

  it('renders read-only without the write permission', () => {
    render(<TaxSettings canEdit={false} initialSettings={excluded} />)
    expect(screen.getByLabelText(/tax computed on top of the price/i)).toBeDisabled()
    expect(screen.getByLabelText(/tax already included in the price/i)).toBeDisabled()
    expect(screen.getByText(/settings:tax:write permission/)).toBeInTheDocument()
  })
})
