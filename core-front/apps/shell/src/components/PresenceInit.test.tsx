import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'

const socket = vi.hoisted(() => ({
  connectPresenceSocket: vi.fn(),
  disconnectPresenceSocket: vi.fn(),
}))
vi.mock('@eerp/core-front', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@eerp/core-front')>()),
  ...socket,
}))

import { useSessionStore } from '@eerp/core-front'
import { PresenceInit } from './PresenceInit'

beforeEach(() => {
  socket.connectPresenceSocket.mockReset()
  socket.disconnectPresenceSocket.mockReset()
  useSessionStore.setState({ identity: null })
})

describe('PresenceInit', () => {
  it('stays disconnected without a session', () => {
    render(<PresenceInit />)
    expect(socket.connectPresenceSocket).not.toHaveBeenCalled()
    expect(socket.disconnectPresenceSocket).toHaveBeenCalled()
  })

  it('connects once signed in and disconnects on unmount', () => {
    useSessionStore.setState({
      identity: { userId: 'u1', tenantId: 't1', roles: [], permissions: [] },
    })
    const { unmount } = render(<PresenceInit />)
    expect(socket.connectPresenceSocket).toHaveBeenCalledTimes(1)
    unmount()
    expect(socket.disconnectPresenceSocket).toHaveBeenCalled()
  })
})
