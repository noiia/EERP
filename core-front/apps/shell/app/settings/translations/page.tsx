import { requireAuth } from '@/lib/session'
import TranslationSettings from '@/components/TranslationSettings'

// Settings → Translations: pick the interface language and add/remove the
// translations modules ship (i18n/*.po, discovered at build time). Auth-gated; the
// manager itself is a Client Component because both the language choice and the
// enabled set are per-user preferences persisted client-side (like the theme).
export default async function TranslationsPage() {
  await requireAuth('/settings/translations')
  return <TranslationSettings />
}
