import { beforeEach, describe, expect, it } from 'vitest'
import { handleNotificationFrame, useNotificationStore, type AppNotification } from './notification-store'

const n = (over: Partial<AppNotification> = {}): AppNotification => ({
  id: 'n1', category: 'dev_seed', kind: 'activity', title: 'Seeding', body: '', link: '/settings/developer',
  status: 'running', progress: 0, progress_label: null, finished_at: null, created_at: '2026-10-13T10:00:00Z',
  data: null, read: false, ...over,
})

describe('useNotificationStore', () => {
  beforeEach(() => useNotificationStore.setState({ items: [], unread: 0, hasNew: false, loaded: false }))

  it('seeds from the feed without flagging anything new', () => {
    useNotificationStore.getState().setFeed([n()], 1)
    expect(useNotificationStore.getState()).toMatchObject({ unread: 1, hasNew: false, loaded: true })
  })

  it('a live arrival inserts, counts unread and flags new; an update of it does not double count', () => {
    const live: Omit<AppNotification, 'read'> = (({ read, ...rest }) => (void read, rest))(n())
    expect(handleNotificationFrame({ type: 'notification', notification: live })).toBe(true)
    expect(useNotificationStore.getState()).toMatchObject({ unread: 1, hasNew: true })
    handleNotificationFrame({ type: 'notification', notification: { ...live, progress: 50 } })
    const s = useNotificationStore.getState()
    expect(s.items).toHaveLength(1)
    expect(s.items[0]!.progress).toBe(50)
    expect(s.unread).toBe(1)
  })

  it('applies another tab\'s read marks', () => {
    useNotificationStore.getState().setFeed([n({ id: 'a' }), n({ id: 'b' })], 2)
    handleNotificationFrame({ type: 'notification_read', ids: ['a'] })
    expect(useNotificationStore.getState().unread).toBe(1)
    handleNotificationFrame({ type: 'notification_read', all: true })
    expect(useNotificationStore.getState().unread).toBe(0)
  })

  it('ignores presence frames and garbage', () => {
    expect(handleNotificationFrame({ type: 'update' })).toBe(false)
    expect(handleNotificationFrame({ type: 'notification', notification: { nope: 1 } })).toBe(true)
    expect(useNotificationStore.getState().items).toHaveLength(0)
  })

  it('acknowledge stops the new flag but keeps unread', () => {
    useNotificationStore.setState({ hasNew: true, unread: 3 })
    useNotificationStore.getState().acknowledge()
    expect(useNotificationStore.getState()).toMatchObject({ hasNew: false, unread: 3 })
  })
})
