import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const getModuleLogsMock = vi.fn()
vi.mock('@/lib/module-actions', () => ({
  getModuleLogs: (...args: unknown[]) => getModuleLogsMock(...args),
}))

import { useSessionStore, type Identity } from '@eerp/core-front'
import { LogsButton } from './LogsButton'

function identityWith(permissions: string[]): Identity {
  return { userId: 'u1', tenantId: 't1', roles: ['tester'], permissions }
}

beforeEach(() => {
  getModuleLogsMock.mockReset()
  useSessionStore.setState({ identity: null })
})

describe('LogsButton', () => {
  it('renders nothing without modules:modules:read', () => {
    useSessionStore.setState({ identity: identityWith([]) })
    render(<LogsButton name="crm" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('opens the dialog, fetches logs, and groups entries by operation', async () => {
    useSessionStore.setState({ identity: identityWith(['modules:modules:read']) })
    // Mirrors OpLogRepository.forModule's real contract: every row, across
    // every operation, sorted newest-first GLOBALLY.
    getModuleLogsMock.mockResolvedValue([
      {
        operationId: 'op-2',
        operation: 'deactivate',
        source: 'backend',
        level: 'info',
        message: 'deactivate requested',
        createdAt: '2026-07-11T10:00:01.000Z',
      },
      {
        operationId: 'op-1',
        operation: 'activate',
        source: 'db',
        level: 'info',
        message: 'ensured table crm',
        createdAt: '2026-07-11T09:00:00.500Z',
      },
      {
        operationId: 'op-1',
        operation: 'activate',
        source: 'backend',
        level: 'info',
        message: 'activate requested',
        createdAt: '2026-07-11T09:00:00.000Z',
      },
    ])

    render(<LogsButton name="crm" />)
    fireEvent.click(screen.getByRole('button', { name: 'Logs' }))

    await waitFor(() => expect(getModuleLogsMock).toHaveBeenCalledWith('crm'))
    await waitFor(() => expect(screen.getByText('deactivate requested')).toBeInTheDocument())

    // Two operation groups.
    expect(screen.getAllByText('deactivate')).toHaveLength(1)
    expect(screen.getAllByText('activate')).toHaveLength(1)

    // The db entry of op-1 is offset ~500ms from its group's first entry; both
    // groups' first entries read "+0ms" (op-2 has one entry, op-1's first is
    // its own start).
    expect(screen.getByText('+500ms')).toBeInTheDocument()
    expect(screen.getAllByText('+0ms')).toHaveLength(2)
  })

  it('shows an ErrorAlert when the fetch rejects', async () => {
    useSessionStore.setState({ identity: identityWith(['modules:modules:read']) })
    getModuleLogsMock.mockRejectedValue(new Error('boom'))

    render(<LogsButton name="crm" />)
    fireEvent.click(screen.getByRole('button', { name: 'Logs' }))

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument())
  })

  it('shows an empty state when there are no operations yet', async () => {
    useSessionStore.setState({ identity: identityWith(['modules:modules:read']) })
    getModuleLogsMock.mockResolvedValue([])

    render(<LogsButton name="crm" />)
    fireEvent.click(screen.getByRole('button', { name: 'Logs' }))

    await waitFor(() => expect(screen.getByText('No operations recorded yet.')).toBeInTheDocument())
  })
})
