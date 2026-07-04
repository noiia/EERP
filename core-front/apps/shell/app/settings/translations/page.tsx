import { hasPermission } from '@eerp/core-front'
import { getEffectivePermissions, requireAuth } from '@/lib/session'
import { getMyLocalePreferences } from '@/lib/preferences'
import TranslationSettings from '@/components/TranslationSettings'

// Settings → Translations: the workspace default language plus the add/remove pool
// of translations modules ship (i18n/*.po, discovered at build time). Auth-gated;
// the default is server state (PUT /settings/i18n) so the page resolves the current
// value and whether the caller may edit it (settings:i18n:write) before rendering.
// Go re-authorizes every write — the flag only shapes the UI.
export default async function TranslationsPage() {
  await requireAuth('/settings/translations')
  const preferences = await getMyLocalePreferences()
  const canEditDefault = hasPermission(await getEffectivePermissions(), 'settings:i18n:write')
  return (
    <TranslationSettings
      preferredLocale={preferences ? preferences.preferred_locale : undefined}
      defaultLocale={preferences?.default_locale ?? null}
      canEditDefault={canEditDefault}
    />
  )
}
