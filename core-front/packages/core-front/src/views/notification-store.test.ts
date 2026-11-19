import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('stops the new-item dot once everything is read, even from another tab', () => {
    useNotificationStore.getState().setFeed([n({ id: 'a' })], 1)
    const live: Omit<AppNotification, 'read'> = (({ read, ...rest }) => (void read, rest))(n({ id: 'b' }))
    handleNotificationFrame({ type: 'notification', notification: live })
    expect(useNotificationStore.getState().hasNew).toBe(true)
    handleNotificationFrame({ type: 'notification_read', ids: ['a'] })
    expect(useNotificationStore.getState().hasNew).toBe(true) // 'b' is still unseen
    handleNotificationFrame({ type: 'notification_read', all: true })
    expect(useNotificationStore.getState()).toMatchObject({ unread: 0, hasNew: false })
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

describe('browser notifications', () => {
  const shown: Array<{ title: string; options: NotificationOptions; onclick: (() => void) | null; close: () => void }> = []
  function stub(permission: NotificationPermission, focused: boolean) {
    shown.length = 0
    vi.stubGlobal(
      'Notification',
      Object.assign(
        function (this: (typeof shown)[number], title: string, options: NotificationOptions) {
          Object.assign(this, { title, options, onclick: null, close: vi.fn() })
          shown.push(this)
        },
        { permission },
      ),
    )
    vi.spyOn(document, 'hasFocus').mockReturnValue(focused)
  }
  const live = (over: Partial<AppNotification> = {}) => (({ read, ...rest }) => (void read, rest))(n({ kind: 'message', status: null, ...over }))

  beforeEach(() => useNotificationStore.setState({ items: [], unread: 0, hasNew: false, loaded: false }))
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('pops a new message up once, tagged by id, when the window is not focused', () => {
    stub('granted', false)
    handleNotificationFrame({ type: 'notification', notification: live({ id: 'm1', title: 'Ann in #general', body: 'hi' }) })
    handleNotificationFrame({ type: 'notification', notification: live({ id: 'm1', title: 'Ann in #general', body: 'hi' }) })
    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ title: 'Ann in #general', options: { body: 'hi', tag: 'm1' } })
  })

  it('stays quiet when focused, not granted, or for an activity', () => {
    stub('granted', true)
    handleNotificationFrame({ type: 'notification', notification: live({ id: 'a' }) })
    stub('default', false)
    handleNotificationFrame({ type: 'notification', notification: live({ id: 'b' }) })
    stub('granted', false)
    handleNotificationFrame({ type: 'notification', notification: live({ id: 'c', kind: 'activity', status: 'running' }) })
    expect(shown).toHaveLength(0)
  })

  it('a click focuses the ERP and opens an ERP link only', () => {
    stub('granted', false)
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})
    handleNotificationFrame({ type: 'notification', notification: live({ id: 'x', link: '//evil.example' }) })
    shown[0]!.onclick!()
    expect(focus).toHaveBeenCalled()
    expect(shown[0]!.close).toHaveBeenCalled()
  })
})
