import { create } from 'zustand'
import { erpPath } from '../navigation'
import { translate } from '../i18n/translate'
import { useI18nStore } from '../i18n/i18n-store'

// The bell's state: the caller's notifications, seeded by one BFF read and kept
// live by the presence socket (presence-store.ts dispatches notification frames
// here). Not persisted — live server state, like presence. Go only ever sends
// a browser the notifications its user may see (internal/notify computes the
// audience), so nothing here filters for privacy.

export interface AppNotification {
  id: string
  category: string
  kind: 'message' | 'activity'
  title: string
  body: string
  link: string
  status: 'running' | 'done' | 'failed' | null
  progress: number | null
  progress_label: string | null
  finished_at: string | null
  created_at: string
  data: string | null
  read: boolean
}

export interface NotificationState {
  items: AppNotification[]
  unread: number
  hasNew: boolean
  loaded: boolean
  setFeed: (items: AppNotification[], unread: number) => void
  upsert: (n: Omit<AppNotification, 'read'>) => void
  markRead: (ids: string[] | 'all') => void
  acknowledge: () => void
}

const countUnread = (items: AppNotification[]) => items.filter((i) => !i.read).length

/** Running activities first, then newest first — the feed's own order. */
function sorted(items: AppNotification[]): AppNotification[] {
  return [...items].sort((a, b) => {
    const ra = a.status === 'running' ? 1 : 0
    const rb = b.status === 'running' ? 1 : 0
    return rb - ra || b.created_at.localeCompare(a.created_at)
  })
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  items: [],
  unread: 0,
  hasNew: false,
  loaded: false,
  setFeed: (items, unread) => set({ items: sorted(items), unread, loaded: true }),
  upsert: (n) => {
    const existing = get().items.find((i) => i.id === n.id)
    const items = existing
      ? get().items.map((i) => (i.id === n.id ? { ...n, read: i.read } : i))
      : [{ ...n, read: false }, ...get().items]
    set({ items: sorted(items), unread: countUnread(items), hasNew: get().hasNew || !existing })
  },
  markRead: (ids) => {
    const items = get().items.map((i) => (ids === 'all' || ids.includes(i.id) ? { ...i, read: true } : i))
    const unread = countUnread(items)
    // Nothing left unread (here or read in another tab): nothing new to flag.
    set({ items, unread, hasNew: get().hasNew && unread > 0 })
  },
  acknowledge: () => set({ hasNew: false }),
}))

function isNotification(v: unknown): v is Omit<AppNotification, 'read'> {
  const o = v as Record<string, unknown> | null
  return !!o && typeof o.id === 'string' && typeof o.title === 'string' && typeof o.link === 'string'
}

/** Applies one live frame; true when it was a notification frame (handled or not). */
export function handleNotificationFrame(msg: { type?: string; notification?: unknown; ids?: string[]; all?: boolean }): boolean {
  if (msg.type === 'notification') {
    if (isNotification(msg.notification)) {
      const isNew = !useNotificationStore.getState().items.some((i) => i.id === (msg.notification as AppNotification).id)
      useNotificationStore.getState().upsert(msg.notification)
      if (isNew) showBrowserNotification(msg.notification)
    }
    return true
  }
  if (msg.type === 'notification_read') {
    useNotificationStore.getState().markRead(msg.all ? 'all' : (msg.ids ?? []))
    return true
  }
  return false
}

/** An ERP path only — mirrors Go's notify.ValidLink. */
const isErpPath = (link: string) => link.startsWith('/') && !link.startsWith('//') && !/[\\:]/.test(link)

/**
 * Shows a live personal message (a Teams message, a failed cron run…) as a
 * system notification while the ERP window isn't focused and the user granted
 * the permission. Go already left out the users who muted the conversation,
 * so every message frame that reaches here is one to show. Activities (their
 * progress frames) never pop up. `tag` = the notification id, so several
 * open tabs show it once.
 */
export function showBrowserNotification(n: Omit<AppNotification, 'read'>): void {
  if (n.kind !== 'message' || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  if (typeof document !== 'undefined' && document.hasFocus()) return
  const locale = useI18nStore.getState().locale
  const shown = new Notification(translate(locale, n.title), { body: n.body, tag: n.id })
  shown.onclick = () => {
    window.focus()
    if (isErpPath(n.link)) window.location.assign(erpPath(n.link))
    shown.close()
  }
}

const reconnectListeners = new Set<() => void>()

/** Called by the presence socket on every (re)connect: frames sent while the
 * socket was down are not replayed, so the feed is re-read. */
export function onLiveReconnect(cb: () => void): () => void {
  reconnectListeners.add(cb)
  return () => reconnectListeners.delete(cb)
}

export function notifyLiveReconnect(): void {
  for (const cb of reconnectListeners) cb()
}
