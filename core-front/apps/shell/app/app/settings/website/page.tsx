import { requireAuth } from '@/lib/session'
import WebsiteHub from '@/components/WebsiteHub'

// Settings → Website: hub for the three website admin pages. Go authorizes each.
export default async function WebsiteSettingsPage() {
  await requireAuth('/settings/website')
  return <WebsiteHub />
}
