// Effective-locale resolution: the one place that turns the server-side language
// preferences (per-user preferred_locale + tenant-wide default_locale) into the
// locale the UI actually renders. Kept pure so the precedence rules are unit-tested
// without a store or a network.

/**
 * Reserved preferred_locale value: the user explicitly forces the untranslated
 * source language (msgids, i.e. English) even when the workspace default points at
 * a translation. Matches the backend's settings.SourceLocale.
 */
export const SOURCE_PREFERENCE = 'source'

/**
 * Server-owned language preferences, as returned by GET /me/preferences.
 * preferred_locale: null = inherit the workspace default, "source" = force the
 * source language, otherwise a locale tag. default_locale: null = source language.
 */
export interface LocalePreferences {
  preferred_locale: string | null
  default_locale: string | null
}

/**
 * Resolve the locale the UI should render (null = source language):
 * the user's choice wins over the workspace default, and a preference pointing at
 * a translation the build no longer ships (a module's .po removed between builds)
 * falls back to the default rather than rendering nothing.
 */
export function resolveEffectiveLocale(
  preferences: LocalePreferences,
  pool: readonly string[],
): string | null {
  const { preferred_locale: preferred, default_locale: fallback } = preferences
  if (preferred === SOURCE_PREFERENCE) return null
  if (preferred && pool.includes(preferred)) return preferred
  if (fallback && pool.includes(fallback)) return fallback
  return null
}
