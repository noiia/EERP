'use client'
import { useEffect } from 'react'
import { onLiveReconnect, useNotificationStore, useSessionStore } from '@eerp/core-front'
import { loadNotifications } from '@/lib/notification-actions'

// Loads the caller's notifications once a session exists, and again whenever
// the live socket reconnects (frames missed while it was down aren't replayed).
export function NotificationsInit() {
  const hasIdentity = useSessionStore((s) => s.identity !== null)
  useEffect(() => {
    if (!hasIdentity) {
      useNotificationStore.setState({ items: [], unread: 0, hasNew: false, loaded: false })
      return
    }
    const load = () =>
      void loadNotifications().then((feed) => {
        if (feed) useNotificationStore.getState().setFeed(feed.items, feed.unread)
      })
    load()
    return onLiveReconnect(load)
  }, [hasIdentity])
  return null
}
