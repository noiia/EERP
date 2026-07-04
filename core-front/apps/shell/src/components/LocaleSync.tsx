'use client'
import { useEffect } from 'react'
import { translationRegistry, useI18nStore } from '@eerp/core-front'
import { resolveEffectiveLocale, type LocalePreferences } from '@/lib/locale'
// Catalogs register as an import side effect; importing here guarantees the pool is
// populated before the sync validates the server preference against it.
import '@/generated/generated-translations'

// Applies the server-owned language preferences (per-user choice + workspace
// default, fetched by the root layout) to the client i18n store on load. The server
// is the source of truth — useI18nStore is its client mirror, kept for instant
// rendering and as the fallback while logged out or when the read failed
// (preferences === null). A locale arriving from the server is auto-enabled so it
// is selectable in the settings UIs even on a browser that never "added" it.
export function LocaleSync({ preferences }: { preferences: LocalePreferences | null }) {
  useEffect(() => {
    if (!preferences) return
    const pool = translationRegistry.locales().map((info) => info.locale)
    const effective = resolveEffectiveLocale(preferences, pool)
    const { locale, addLocale, setLocale } = useI18nStore.getState()
    if (effective) addLocale(effective)
    if (locale !== effective) setLocale(effective)
  }, [preferences])
  return null
}
