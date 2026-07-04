import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Language preference, persisted to localStorage like the rest of the UI prefs
// (ui-store). Two pieces of state, both per-user and client-owned:
//  - enabledLocales: the translations the user has ADDED in Settings → Translations,
//    out of everything modules ship (the registry is the pool, this is the selection).
//  - locale: the ACTIVE language, chosen among the enabled ones. `null` means the
//    source language (the untranslated msgids, i.e. English) — always available.
// The store is deliberately dumb: it does not know the registry. The settings UI
// validates against `translationRegistry.locales()` and prunes stale persisted
// locales (a module's .po may disappear between builds).

/** The source language: render msgids untranslated. Always selectable. */
export const SOURCE_LOCALE = null

export interface I18nState {
  /** Active locale tag, or null for the source language. */
  locale: string | null
  /** Locales the user added in Settings → Translations. */
  enabledLocales: string[]
  setLocale: (locale: string | null) => void
  /** Add a discovered translation to the enabled set (idempotent). */
  addLocale: (locale: string) => void
  /** Remove a translation; if it was active, fall back to the source language. */
  removeLocale: (locale: string) => void
}

export const useI18nStore = create<I18nState>()(
  persist(
    (set) => ({
      locale: SOURCE_LOCALE,
      enabledLocales: [],
      setLocale: (locale) => set({ locale }),
      addLocale: (locale) =>
        set((state) =>
          state.enabledLocales.includes(locale)
            ? state
            : { enabledLocales: [...state.enabledLocales, locale] },
        ),
      removeLocale: (locale) =>
        set((state) => ({
          enabledLocales: state.enabledLocales.filter((l) => l !== locale),
          locale: state.locale === locale ? SOURCE_LOCALE : state.locale,
        })),
    }),
    { name: 'eerp-i18n', version: 1 },
  ),
)
