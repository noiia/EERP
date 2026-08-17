import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { OSMConnector } from '@/lib/osm-settings'

// The save is a Server Action; the component only sees its result object.
const saveMock = vi.fn()
vi.mock('@/lib/osm-settings', () => ({
  setOSMConnector: (connector: OSMConnector) => saveMock(connector),
}))

import OSMConnectorSettings from './OSMConnectorSettings'

const disabled: OSMConnector = { enabled: false, base_url: '', user_agent: '' }

beforeEach(() => {
  saveMock.mockReset()
  saveMock.mockResolvedValue({ ok: true })
})

describe('OSMConnectorSettings', () => {
  it('shows the stored connector config', () => {
    render(
      <OSMConnectorSettings
        canEdit
        initialConnector={{ enabled: true, base_url: 'https://nominatim.openstreetmap.org', user_agent: 'eerp/1.0' }}
      />,
    )
    expect(screen.getByLabelText('Enabled')).toBeChecked()
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://nominatim.openstreetmap.org')
    expect(screen.getByLabelText('User agent')).toHaveValue('eerp/1.0')
  })

  it('saves immediately when the Enabled switch is toggled', async () => {
    render(<OSMConnectorSettings canEdit initialConnector={disabled} />)
    fireEvent.click(screen.getByLabelText('Enabled'))
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({ enabled: true, base_url: '', user_agent: '' }),
    )
  })

  it('saves the base URL on blur', async () => {
    render(<OSMConnectorSettings canEdit initialConnector={disabled} />)
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'https://nominatim.openstreetmap.org' },
    })
    fireEvent.blur(screen.getByLabelText('Base URL'))
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({
        enabled: false,
        base_url: 'https://nominatim.openstreetmap.org',
        user_agent: '',
      }),
    )
  })

  it('saves the user agent on blur', async () => {
    render(<OSMConnectorSettings canEdit initialConnector={disabled} />)
    fireEvent.change(screen.getByLabelText('User agent'), { target: { value: 'eerp/1.0' } })
    fireEvent.blur(screen.getByLabelText('User agent'))
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({ enabled: false, base_url: '', user_agent: 'eerp/1.0' }),
    )
  })

  it('surfaces the error message on a failed save', async () => {
    saveMock.mockResolvedValue({ ok: false, message: 'Missing permission settings:integrations:write' })
    render(<OSMConnectorSettings canEdit initialConnector={disabled} />)
    fireEvent.blur(screen.getByLabelText('Base URL'))
    expect(await screen.findByText('Missing permission settings:integrations:write')).toBeInTheDocument()
  })

  it('renders read-only without the write permission', () => {
    render(<OSMConnectorSettings canEdit={false} initialConnector={disabled} />)
    expect(screen.getByLabelText('Enabled')).toBeDisabled()
    expect(screen.getByLabelText('Base URL')).toBeDisabled()
    expect(screen.getByLabelText('User agent')).toBeDisabled()
    expect(screen.getByText(/settings:integrations:write permission/)).toBeInTheDocument()
  })
})
