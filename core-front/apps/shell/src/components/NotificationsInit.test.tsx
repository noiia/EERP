import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { notifyLiveReconnect, useNotificationStore, useSessionStore } from '@eerp/core-front'

const loadNotifications = vi.fn()
vi.mock('@/lib/notification-actions', () => ({ loadNotifications: () => loadNotifications() }))

import { NotificationsInit } from './NotificationsInit'

const identity = { userId: 'u1', tenantId: 't1', roles: [], permissions: [] }

describe('NotificationsInit', () => {
  beforeEach(() => {
    loadNotifications.mockReset()
    useNotificationStore.setState({ items: [], unread: 0, hasNew: false, loaded: false })
  })

  it('loads the feed once signed in, and again after the live socket reconnects', async () => {
    loadNotifications.mockResolvedValue({ items: [], unread: 4 })
    useSessionStore.setState({ identity } as never)
    render(<NotificationsInit />)
    await waitFor(() => expect(useNotificationStore.getState()).toMatchObject({ unread: 4, loaded: true }))
    notifyLiveReconnect()
    await waitFor(() => expect(loadNotifications).toHaveBeenCalledTimes(2))
  })

  it('clears the store when there is no session', () => {
    useNotificationStore.setState({ unread: 2, loaded: true })
    useSessionStore.setState({ identity: null } as never)
    render(<NotificationsInit />)
    expect(useNotificationStore.getState()).toMatchObject({ unread: 0, loaded: false })
    expect(loadNotifications).not.toHaveBeenCalled()
  })
})
