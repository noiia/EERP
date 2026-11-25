import { create } from 'zustand'
import { handleChatFrame } from './chat-frames'
import { handleNotificationFrame, notifyLiveReconnect } from './notification-store'

// Live user presence — online/absent/offline/busy/do_not_disturb — pushed
// over a WebSocket the browser opens DIRECTLY against core-back, the one
// deliberate exception to "the browser talks only to Next" (CONVENTIONS.md's
// State model / docs/adr/ADR-019-user-presence-websocket.md): a live socket
// needs the real connection the BFF's server-rendered/Server-Action model
// doesn't have, and the same httpOnly session cookie the BFF already sets
// authenticates it automatically (same-origin request, core-back's
// JWTOrCookieMiddleware reads it) — no token ever reaches this file.
//
// No persist: this is live server state, not a per-viewer preference: a
// stale cached snapshot from a previous session would just be wrong.

export type PresenceStatus = 'online' | 'absent' | 'offline' | 'busy' | 'do_not_disturb'

export interface PresenceState {
  statuses: Readonly<Record<string, PresenceStatus>>
  setSnapshot: (entries: { user_id: string; status: PresenceStatus }[]) => void
  setOne: (userId: string, status: PresenceStatus) => void
}

export const usePresenceStore = create<PresenceState>((set, get) => ({
  statuses: {},
  setSnapshot: (entries) => {
    const statuses: Record<string, PresenceStatus> = {}
    for (const e of entries) statuses[e.user_id] = e.status
    set({ statuses })
  },
  setOne: (userId, status) => set({ statuses: { ...get().statuses, [userId]: status } }),
}))

/** A user this session has never heard a status for renders as offline. */
export function presenceStatusOf(userId: string): PresenceStatus {
  return usePresenceStore.getState().statuses[userId] ?? 'offline'
}

function presenceWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/api/v1/presence`
}

let socket: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const RECONNECT_MIN_MS = 3000
const RECONNECT_MAX_MS = 60000
const STABLE_MS = 30000
let failures = 0
let openedAt = 0
// The first open after connect only starts the live feed: every consumer did its own first
// read on mount, so re-reading then would double each read (Teams' sidebar, the bell).
let everOpened = false

/**
 * Opens the presence socket (idempotent — a second call while one is already
 * open/connecting is a no-op) and wires it into usePresenceStore. Reconnects
 * on close/error with exponential backoff (3s doubling to 60s, ±20% jitter),
 * back to 3s once a socket stayed open 30s: every (re)open re-reads the
 * notification feed and the Teams sidebar, so a socket a proxy keeps dropping
 * (or a 429 on the handshake) must not retry at a fixed pace, nor every tab
 * of a shared IP in step. Call disconnectPresenceSocket() on logout/unmount to
 * stop reconnecting.
 */
export function connectPresenceSocket(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  if (typeof window === 'undefined') return

  const ws = new WebSocket(presenceWsUrl())
  socket = ws

  ws.onmessage = (event) => {
    let msg: unknown
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    // The same socket carries notification frames (internal/notify).
    if (handleNotificationFrame(msg as Parameters<typeof handleNotificationFrame>[0])) return
    if (handleChatFrame(msg as { type?: string })) return
    const m = msg as { type?: string; users?: { user_id: string; status: PresenceStatus }[]; user_id?: string; status?: PresenceStatus }
    if (m.type === 'snapshot' && m.users) {
      usePresenceStore.getState().setSnapshot(m.users)
    } else if (m.type === 'update' && m.user_id && m.status) {
      usePresenceStore.getState().setOne(m.user_id, m.status)
    }
  }
  // Frames sent while the socket was down aren't replayed: re-read the feed.
  ws.onopen = () => {
    openedAt = Date.now()
    if (everOpened) notifyLiveReconnect()
    everOpened = true
  }
  ws.onclose = () => {
    if (openedAt && Date.now() - openedAt >= STABLE_MS) failures = 0
    openedAt = 0
    scheduleReconnect()
  }
  ws.onerror = () => ws.close()
}

function scheduleReconnect() {
  socket = null
  if (reconnectTimer) return
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** failures) * (0.8 + Math.random() * 0.4)
  failures++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectPresenceSocket()
  }, delay)
}

/** Stops the socket and any pending reconnect — call on logout/unmount. */
export function disconnectPresenceSocket(): void {
  failures = 0
  openedAt = 0
  everOpened = false
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (socket) {
    socket.onclose = null
    socket.close()
    socket = null
  }
}

/**
 * Sets (or clears, passing null) the caller's own manual status override.
 * Direct fetch to core-back (same deliberate BFF exception as the socket
 * above) — the store updates once the socket echoes the resulting "update"
 * message back, so this doesn't optimistically mutate state itself.
 */
export async function setPresenceStatus(status: 'busy' | 'do_not_disturb' | null): Promise<void> {
  await fetch('/api/v1/presence', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: status ?? '' }),
  })
}

/** One-shot snapshot fetch — used as a fallback if the socket hasn't (yet) delivered one. */
export async function fetchPresenceSnapshot(): Promise<void> {
  const res = await fetch('/api/v1/presence', { credentials: 'include' })
  if (!res.ok) return
  const entries = (await res.json()) as { user_id: string; status: PresenceStatus }[]
  usePresenceStore.getState().setSnapshot(entries)
}
