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
  /**
   * Resolved group closure (a role's own technical_name plus every role it
   * transitively belongs to — core/orm's WithFieldGroups / FieldMeta.Groups).
   * UX mirror only: Go's generic CRUD already omits a gated field's key from
   * the response for a caller outside these groups, so this just keeps
   * layout-renderer.tsx from rendering an empty slot for it. Optional so
   * every existing Identity literal (tests, older sessions) keeps compiling —
   * isFieldVisible treats an absent set as fail-open (don't hide).
   */
  groups?: string[]
  /**
   * Mirrors Go's Claims.MustChangePassword (core/internal/auth/token.go) — set
   * on a freshly-seeded default admin in production (docs/security/pentest-2026-09-24.md's
   * follow-up). Unlike Permissions/Groups above this IS a real gate, not just a UI
   * mirror: Go's PermissionMiddleware enforces it server-side on every route except
   * the self-service credential-change one, so a stale/spoofed client value can
   * never widen access — this field only decides whether the UI routes the caller
   * to the forced-change form. Optional so every existing Identity literal (tests,
   * older sessions) keeps compiling — treated as false when absent.
   */
  mustChangePassword?: boolean
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
