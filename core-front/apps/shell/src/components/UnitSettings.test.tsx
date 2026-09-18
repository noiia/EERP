import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { UnitSettings as UnitSettingsValue } from '@/lib/unit-settings'

// The save is a Server Action; the component only sees its result object.
const saveMock = vi.fn()
vi.mock('@/lib/unit-settings', () => ({
  setUnitSettings: (settings: UnitSettingsValue) => saveMock(settings),
}))

import UnitSettings from './UnitSettings'

const metric: UnitSettingsValue = { system: 'metric' }

beforeEach(() => {
  saveMock.mockReset()
  saveMock.mockResolvedValue({ ok: true })
})

describe('UnitSettings', () => {
  it('shows the stored unit system', () => {
    render(<UnitSettings canEdit initialSettings={{ system: 'imperial' }} />)
    expect(screen.getByLabelText(/imperial/i)).toBeChecked()
    expect(screen.getByLabelText(/metric/i)).not.toBeChecked()
  })

  it('saves immediately when the system is switched', async () => {
    render(<UnitSettings canEdit initialSettings={metric} />)
    fireEvent.click(screen.getByLabelText(/imperial/i))
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith({ system: 'imperial' }))
  })

  it('surfaces the error message on a failed save', async () => {
    saveMock.mockResolvedValue({ ok: false, message: 'Missing permission settings:units:write' })
    render(<UnitSettings canEdit initialSettings={metric} />)
    fireEvent.click(screen.getByLabelText(/imperial/i))
    expect(await screen.findByText('Missing permission settings:units:write')).toBeInTheDocument()
  })

  it('renders read-only without the write permission', () => {
    render(<UnitSettings canEdit={false} initialSettings={metric} />)
    expect(screen.getByLabelText(/metric/i)).toBeDisabled()
    expect(screen.getByLabelText(/imperial/i)).toBeDisabled()
    expect(screen.getByText(/settings:units:write permission/)).toBeInTheDocument()
  })
})
