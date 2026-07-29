import { requireAuth } from '@/lib/session'
import DeveloperSettings from '@/components/DeveloperSettings'
import { seedingAllowed } from '@/lib/dev-seed'

// Settings → Developer: dev-only tools for testing the software. Auth-gated like
// every settings page; the seed action itself is also guarded server-side via the
// same seedingAllowed() check (defense in depth — never trust a hidden/disabled
// button alone to keep bulk fake writes out of a real tenant).
export default async function DeveloperPage() {
  await requireAuth('/settings/developer')
  return <DeveloperSettings isDev={seedingAllowed()} />
}
