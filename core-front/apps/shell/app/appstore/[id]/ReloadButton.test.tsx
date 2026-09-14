import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const refreshMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}))

const reloadModuleMock = vi.fn()
vi.mock('@/lib/module-actions', () => ({
  reloadModule: (...args: unknown[]) => reloadModuleMock(...args),
}))

import { useSessionStore, type Identity } from '@eerp/core-front'
import { ReloadButton } from './ReloadButton'

function identityWith(permissions: string[]): Identity {
  return { userId: 'u1', tenantId: 't1', roles: ['tester'], permissions }
}

beforeEach(() => {
  refreshMock.mockClear()
  reloadModuleMock.mockReset()
  useSessionStore.setState({ identity: null })
})

describe('ReloadButton', () => {
  it('renders nothing without modules:modules:write', () => {
    useSessionStore.setState({ identity: identityWith([]) })
    render(<ReloadButton name="crm" type="wasm" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders nothing for a Go-type module — its code needs a rebuild, not a reload', () => {
    useSessionStore.setState({ identity: identityWith(['modules:modules:write']) })
    render(<ReloadButton name="crm" type="go" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('calls reloadModule and refreshes on click for a WASM-type module', async () => {
    useSessionStore.setState({ identity: identityWith(['modules:modules:write']) })
    reloadModuleMock.mockResolvedValue({ active: true })
    render(<ReloadButton name="crm" type="wasm" />)

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(reloadModuleMock).toHaveBeenCalledWith('crm'))
    await waitFor(() => expect(refreshMock).toHaveBeenCalled())
  })

  it('shows an ErrorAlert when the reload rejects', async () => {
    useSessionStore.setState({ identity: identityWith(['modules:modules:write']) })
    reloadModuleMock.mockRejectedValue(new Error('boom'))
    render(<ReloadButton name="crm" type="wasm" />)

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument())
  })
})
