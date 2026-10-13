import { requireAuth } from '@/lib/session'
import SettingsHub from './SettingsHub'

// The main settings hub. Auth-gated like the rest of the app (anon → /login); the
// settings themselves are per-user UI preferences resolved on the client, so this
// Server Component only enforces authentication and renders the section catalog.
export default async function SettingsPage() {
  await requireAuth('/settings')
  // Baked into the image by CI (core-front/Dockerfile); unset outside a CI build.
  return <SettingsHub version={process.env.EERP_VERSION || 'dev'} />
}
