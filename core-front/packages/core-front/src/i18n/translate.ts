import { translationRegistry } from './registry'
import { useI18nStore } from './i18n-store'

// The lookup side of i18n. Gettext-style: source strings are the keys, so untranslated
// UI keeps working verbatim — `t('Settings')` returns 'Settings' until a module ships a
// catalog entry for it. No interpolation/plural engine yet; strings translate 1:1
// (add ICU-style formatting the day a real plural shows up, not before).

/** Translate one source string for a locale; falls back to the source string. */
export function translate(locale: string | null, text: string): string {
  if (!locale) return text
  return translationRegistry.catalog(locale)[text] ?? text
}

/**
 * Client hook: a `t()` bound to the active locale. Subscribes to the i18n store, so
 * switching the language in Settings re-renders every translated component live
 * (same pattern as the theme palette).
 */
export function useT(): (text: string) => string {
  const locale = useI18nStore((s) => s.locale)
  return (text: string) => translate(locale, text)
}

/**
 * Human name of a locale tag ('fr' -> 'French' / 'français'), via Intl.DisplayNames
 * when available; falls back to the raw tag. `inLocale` picks the naming language —
 * pass the tag itself for an endonym.
 */
export function localeDisplayName(tag: string, inLocale = 'en'): string {
  try {
    return new Intl.DisplayNames([inLocale], { type: 'language' }).of(tag) ?? tag
  } catch {
    return tag
  }
}
