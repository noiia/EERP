import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// The active company's currency, client mirror — same "server state, seeded
// once at preferences load, persisted so a reload doesn't flash the built-in
// default" shape as useFormatStore (format-store.ts), just one field instead
// of a decimal/thousands pair. Reconciled by the shell's LocaleSync from
// GET /me/preferences' active_company.currency, which rides along with the
// SAME round-trip the locale/number-format mirrors already use — no separate
// fetch. `number/monetary` widgets (widgets.tsx) render through this.

export interface CompanyState {
  /** e.g. "USD" — empty until the first preferences load resolves one. */
  currency: string
  setCurrency: (currency: string) => void
}

export const useCompanyStore = create<CompanyState>()(
  persist(
    (set) => ({
      currency: '',
      setCurrency: (currency) => set({ currency }),
    }),
    { name: 'eerp-company', version: 1 },
  ),
)
