import { apiRequest } from '@eerp/core-front/server'
import { requireAuth } from '@/lib/session'
import SettingsHub, { type ServiceVersion } from './SettingsHub'

// The main settings hub. Auth-gated like the rest of the app (anon → /login); the
// settings themselves are per-user UI preferences resolved on the client, so this
// Server Component only enforces authentication, renders the section catalog, and
// gathers which build of each service is running (shown at the bottom).
export default async function SettingsPage() {
  await requireAuth('/settings')
  return <SettingsHub versions={await serviceVersions()} />
}

/** This frontend's own version (baked into the image by CI, core-front/Dockerfile),
 * then every service Go reports (core first — internal/version; a service is added
 * there, not here). Go unreachable ⇒ the frontend's alone. */
async function serviceVersions(): Promise<ServiceVersion[]> {
  const own: ServiceVersion = { name: 'core-front', label: 'Frontend', version: process.env.EERP_VERSION || 'dev' }
  try {
    const { services } = await apiRequest<{ services?: ServiceVersion[] }>('GET', '/versions')
    return [own, ...(services ?? [])]
  } catch {
    return [own]
  }
}
