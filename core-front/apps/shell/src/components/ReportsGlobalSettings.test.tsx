import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReportsLayout } from '@/lib/report-settings'

// The save is a Server Action; the component only sees its result object.
const saveMock = vi.fn()
vi.mock('@/lib/report-settings', () => ({
  setReportsLayout: (layout: ReportsLayout) => saveMock(layout),
}))

import ReportsGlobalSettings from './ReportsGlobalSettings'

beforeEach(() => {
  saveMock.mockReset()
  saveMock.mockResolvedValue({ ok: true })
})

describe('ReportsGlobalSettings', () => {
  it('shows the stored footer/address', () => {
    render(<ReportsGlobalSettings canEdit initialFooter="Thank you." initialAddress="1 Rue de la Paix" />)
    expect(screen.getByLabelText('Footer')).toHaveValue('Thank you.')
    expect(screen.getByLabelText('Address')).toHaveValue('1 Rue de la Paix')
  })

  it('saves the footer on blur', async () => {
    render(<ReportsGlobalSettings canEdit initialFooter="" initialAddress="" />)
    fireEvent.change(screen.getByLabelText('Footer'), { target: { value: 'New footer' } })
    fireEvent.blur(screen.getByLabelText('Footer'))

    await waitFor(() => expect(saveMock).toHaveBeenCalledWith({ footer: 'New footer', address: '' }))
  })

  it('saves the address on blur', async () => {
    render(<ReportsGlobalSettings canEdit initialFooter="" initialAddress="" />)
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'New address' } })
    fireEvent.blur(screen.getByLabelText('Address'))

    await waitFor(() => expect(saveMock).toHaveBeenCalledWith({ footer: '', address: 'New address' }))
  })

  it('surfaces the error message on a failed save', async () => {
    saveMock.mockResolvedValue({ ok: false, message: 'Missing permission settings:reports:write' })
    render(<ReportsGlobalSettings canEdit initialFooter="" initialAddress="" />)
    fireEvent.blur(screen.getByLabelText('Footer'))

    expect(await screen.findByText('Missing permission settings:reports:write')).toBeInTheDocument()
  })

  it('renders read-only without the write permission', () => {
    render(<ReportsGlobalSettings canEdit={false} initialFooter="" initialAddress="" />)
    expect(screen.getByLabelText('Footer')).toBeDisabled()
    expect(screen.getByLabelText('Address')).toBeDisabled()
    expect(screen.getByText(/settings:reports:write permission/)).toBeInTheDocument()
  })
})
