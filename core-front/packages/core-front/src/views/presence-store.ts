import { create } from 'zustand'

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

/**
 * Opens the presence socket (idempotent — a second call while one is already
 * open/connecting is a no-op) and wires it into usePresenceStore. Reconnects
 * on close/error after a fixed 3s delay — presence is best-effort live data,
 * not a queue that needs backoff/jitter at this scale (a handful to a few
 * hundred concurrent users per tenant). Call disconnectPresenceSocket() on
 * logout/unmount to stop reconnecting.
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
    const m = msg as { type?: string; users?: { user_id: string; status: PresenceStatus }[]; user_id?: string; status?: PresenceStatus }
    if (m.type === 'snapshot' && m.users) {
      usePresenceStore.getState().setSnapshot(m.users)
    } else if (m.type === 'update' && m.user_id && m.status) {
      usePresenceStore.getState().setOne(m.user_id, m.status)
    }
  }
  ws.onclose = scheduleReconnect
  ws.onerror = () => ws.close()
}

function scheduleReconnect() {
  socket = null
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectPresenceSocket()
  }, 3000)
}

/** Stops the socket and any pending reconnect — call on logout/unmount. */
export function disconnectPresenceSocket(): void {
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
