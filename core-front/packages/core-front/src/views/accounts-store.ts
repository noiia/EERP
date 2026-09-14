import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// The workspace's username display format, client mirror — same "server
// state, seeded once at preferences load, persisted so a reload doesn't
// flash the built-in default" shape as useCompanyStore (company-store.ts).
// Reconciled by the shell's LocaleSync from GET /api/v1/settings/accounts'
// username_at_format, which rides along with the SAME preferences-load pass
// the locale/number-format/currency mirrors already use — no separate fetch.
// `text/username` widgets (widgets.tsx) render through this; it is a pure
// DISPLAY choice — the stored value is never rewritten.

export interface AccountsState {
  usernameAtFormat: boolean
  setUsernameAtFormat: (usernameAtFormat: boolean) => void
}

export const useAccountsStore = create<AccountsState>()(
  persist(
    (set) => ({
      usernameAtFormat: false,
      setUsernameAtFormat: (usernameAtFormat) => set({ usernameAtFormat }),
    }),
    { name: 'eerp-accounts', version: 1 },
  ),
)
