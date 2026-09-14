import { requireAuth } from '@/lib/session'
import { getMyLocalePreferences } from '@/lib/preferences'
import AccountSettings from '@/components/AccountSettings'

// Settings → Account: the caller's own preferences (today: the display language).
// Auth-gated; the preference is server state on the user record, so the page reads
// it (plus the workspace default it may inherit) before rendering the client editor.
export default async function AccountPage() {
  await requireAuth('/settings/account')
  return <AccountSettings preferences={await getMyLocalePreferences()} />
}
