import { hasPermission } from '@eerp/core-front'
import { getEffectivePermissions, requireAuth } from '@/lib/session'
import FormatSettings from '@/components/FormatSettings'

// Settings → Formats: the workspace number display format. Auth-gated; the value is
// server state (PUT /settings/format) already mirrored into useFormatStore by
// LocaleSync on load, so the client component renders from the store. The page only
// resolves whether the caller may edit (settings:format:write) — display gating,
// Go re-authorizes the write.
export default async function FormatsPage() {
  await requireAuth('/settings/formats')
  const canEdit = hasPermission(await getEffectivePermissions(), 'settings:format:write')
  return <FormatSettings canEdit={canEdit} />
}
