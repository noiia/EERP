import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const refreshMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}))

const setModuleActiveMock = vi.fn()
vi.mock('@/lib/module-actions', () => ({
  setModuleActive: (...args: unknown[]) => setModuleActiveMock(...args),
}))

import { useRecentlyChangedStore, useSessionStore, type Identity } from '@eerp/core-front'
import { ActivateButton } from './ActivateButton'

function identityWith(permissions: string[]): Identity {
  return { userId: 'u1', tenantId: 't1', roles: ['tester'], permissions }
}

beforeEach(() => {
  refreshMock.mockClear()
  setModuleActiveMock.mockReset()
  useSessionStore.setState({ identity: null })
  useRecentlyChangedStore.setState({ ids: new Set() })
})

describe('ActivateButton', () => {
  it('renders nothing without modules:modules:write', () => {
    render(<ActivateButton name="crm" active={true} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('shows "Deactivate" for an active module and calls the action on click', async () => {
    useSessionStore.setState({ identity: identityWith(['modules:modules:write']) })
    setModuleActiveMock.mockResolvedValue({ active: false, requiresRestart: true })
    render(<ActivateButton name="crm" active={true} />)

    const button = screen.getByRole('button', { name: 'Deactivate' })
    fireEvent.click(button)

    await waitFor(() => expect(setModuleActiveMock).toHaveBeenCalledWith('crm', false))
    await waitFor(() => expect(refreshMock).toHaveBeenCalled())
  })

  it('shows "Activate" for an inactive module and toggles the other way', async () => {
    useSessionStore.setState({ identity: identityWith(['modules:modules:write']) })
    setModuleActiveMock.mockResolvedValue({ active: true, requiresRestart: true })
    render(<ActivateButton name="crm" active={false} />)

    fireEvent.click(screen.getByRole('button', { name: 'Activate' }))
    await waitFor(() => expect(setModuleActiveMock).toHaveBeenCalledWith('crm', true))
  })

  it('disables itself with a hint for the appstore module deactivating itself', () => {
    useSessionStore.setState({ identity: identityWith(['modules:modules:write']) })
    render(<ActivateButton name="appstore" active={true} />)
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeDisabled()
  })

  it('does NOT self-protect an inactive appstore (reactivating is fine)', () => {
    useSessionStore.setState({ identity: identityWith(['modules:modules:write']) })
    render(<ActivateButton name="appstore" active={false} />)
    expect(screen.getByRole('button', { name: 'Activate' })).toBeEnabled()
  })

  it('flips the label immediately (optimistic), before the write resolves', () => {
    useSessionStore.setState({ identity: identityWith(['modules:modules:write']) })
    setModuleActiveMock.mockReturnValue(new Promise(() => {})) // never resolves
    render(<ActivateButton name="crm" active={true} />)

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }))
    expect(screen.getByRole('button', { name: 'Activate' })).toBeInTheDocument()
  })

  it('reverts the optimistic flip and shows an ErrorAlert when the write rejects', async () => {
    useSessionStore.setState({ identity: identityWith(['modules:modules:write']) })
    setModuleActiveMock.mockRejectedValue(new Error('nope'))
    render(<ActivateButton name="crm" active={true} />)

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }))
    await waitFor(() => expect(screen.getByText('nope')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeInTheDocument()
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it('shows the requires_restart notice and badges the module on a successful write', async () => {
    useSessionStore.setState({ identity: identityWith(['modules:modules:write']) })
    setModuleActiveMock.mockResolvedValue({ active: false, requiresRestart: true })
    render(<ActivateButton name="crm" active={true} />)

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }))
    await waitFor(() =>
      expect(
        screen.getByText('Saved to module.json — takes effect after backend restart + frontend rebuild'),
      ).toBeInTheDocument(),
    )
    expect(useRecentlyChangedStore.getState().ids.has('crm')).toBe(true)
  })

  it('does not show the requires_restart notice when the write omits it', async () => {
    useSessionStore.setState({ identity: identityWith(['modules:modules:write']) })
    setModuleActiveMock.mockResolvedValue({ active: false, requiresRestart: false })
    render(<ActivateButton name="crm" active={true} />)

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }))
    await waitFor(() => expect(refreshMock).toHaveBeenCalled())
    expect(
      screen.queryByText('Saved to module.json — takes effect after backend restart + frontend rebuild'),
    ).not.toBeInTheDocument()
  })
})
