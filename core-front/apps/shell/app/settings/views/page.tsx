import { hasPermission } from '@eerp/core-front'
import { getEffectivePermissions, requireAuth } from '@/lib/session'
import { getEntityViewFields } from '@/lib/view-fields'
import ViewsSettings, { type ViewEntityRow } from '@/components/ViewsSettings'
// Side-effect import: registers every discovered module's FrontModule into the
// shared registry before we enumerate its tree views — same manifest the
// catch-all route and the landing menu import (docs/roadmaps/list-view-modes.md).
import '@/generated/generated-modules'
import { treeViewEntities } from './registry'

// Settings → Views: which field powers each entity's Kanban status column and
// Calendar date positioning. Auth-gated; the page only resolves whether the
// caller may edit (settings:views:write) — display gating, Go re-authorizes
// every write.
export default async function ViewsSettingsPage() {
  await requireAuth('/settings/views')
  const canEdit = hasPermission(await getEffectivePermissions(), 'settings:views:write')

  const entities = treeViewEntities()
  const rows: ViewEntityRow[] = await Promise.all(
    entities.map(async (e) => ({ ...e, config: await getEntityViewFields(e.entity) })),
  )

  return <ViewsSettings rows={rows} canEdit={canEdit} />
}
