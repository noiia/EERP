import { requireAuth } from '@/lib/session'
import AppearanceSettings from '@/components/AppearanceSettings'

// Settings → Appearance: the brand-color manager. Auth-gated; the editor itself is a
// Client Component (it edits the persisted palette in useUiStore and the shell themes
// off that store, so edits re-theme the app live). All the chrome — breadcrumb, title,
// the color controls — lives in that client component because the breadcrumb navigates
// via MUI's `component={Link}`, a function prop that can't cross the RSC boundary.
export default async function AppearancePage() {
  await requireAuth('/settings/appearance')
  return <AppearanceSettings />
}
