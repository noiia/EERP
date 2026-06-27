import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Client session MIRROR for UI gating only. The server is the source of truth:
// identity is resolved server-side from the HttpOnly cookie and authorization is
// enforced on the server. This persisted copy lets <Can> gate UI without a
// round-trip; it holds no secret (no tokens) — just identity + effective
// permissions (CONVENTIONS.md — Session transport / Permissions).

export interface Identity {
  userId: string
  tenantId: string
  roles: string[]
  /** Effective permission DSL strings (module:resource:action), wildcards allowed. */
  permissions: string[]
}

export interface SessionState {
  identity: Identity | null
  setIdentity: (identity: Identity | null) => void
  clear: () => void
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      identity: null,
      setIdentity: (identity) => set({ identity }),
      clear: () => set({ identity: null }),
    }),
    { name: 'eerp-session' },
  ),
)
