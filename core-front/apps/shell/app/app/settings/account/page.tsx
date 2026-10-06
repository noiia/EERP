import Container from '@mui/material/Container'
import { hasPermission } from '@eerp/core-front'
import { getEffectivePermissions, requireAuth } from '@/lib/session'
import { getMyLocalePreferences } from '@/lib/preferences'
import { getMyEventFeed } from '@/lib/event-settings'
import AccountSettings from '@/components/AccountSettings'
import EventFeedSettings from '@/components/EventFeedSettings'

// Settings → Account: the caller's own preferences (the display language) and,
// for staff who can read event sessions, their private events calendar feed.
// Auth-gated; the preference is server state on the user record, so the page reads
// it (plus the workspace default it may inherit) before rendering the client editor.
export default async function AccountPage() {
  await requireAuth('/settings/account')
  const permissions = await getEffectivePermissions()
  const feed = hasPermission(permissions, 'event_session:event_session:read') ? await getMyEventFeed() : null
  return (
    <>
      <AccountSettings preferences={await getMyLocalePreferences()} />
      {feed && (
        <Container maxWidth="md" sx={{ pb: 6 }}>
          <EventFeedSettings enabled={feed.enabled} />
        </Container>
      )}
    </>
  )
}
