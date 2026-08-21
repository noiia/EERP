import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { hasPermission } from '@eerp/core-front'
import { createServerApiClient, toApiError } from '@eerp/core-front/server'
import { getEffectivePermissions, requireAuth } from '@/lib/session'
import { activeModuleNames } from '@/lib/module-state'
import { getEntityViewFields } from '@/lib/view-fields'
import { getEntityChatterVisibility } from '@/lib/chatter-visibility'
import { getModulePictureSize } from '@/lib/app-settings'
import FormatSettings from '@/components/FormatSettings'
import PictureSizeSettings from '@/components/PictureSizeSettings'
import ViewsSettings, { type ViewEntityRow } from '@/components/ViewsSettings'
import ChatterSettings, { type ChatterEntityRow } from '@/components/ChatterSettings'
// Side-effect import: registers every discovered module's FrontModule into
// the shared registry before enumerating its tree views (mirrors
// Settings -> Views' own page, which this one replaces).
import '@/generated/generated-modules'
import { formViewEntities, treeViewEntities } from '../../views/registry'

// Settings -> Apps -> :module: one app's own settings form. `module === 'base'`
// is a reserved, synthetic slug (not a real installed module) for the
// workspace-wide defaults every app inherits unless it overrides them — see
// app/settings/apps/page.tsx's pinned Base row.
//
// This is where Views (Kanban/Calendar field picker) and Formats — previously
// their own standalone Settings Hub pages — are internalized: Format only
// makes sense at the Base level (there's no per-app override for it yet), and
// Views is naturally per-entity, so each app's page shows just the entities
// IT registered (treeViewEntities() already tags each row with its owning
// module — same registry read Settings -> Views used, just filtered).

export default async function AppSettingsPage({
  params,
}: {
  params: Promise<{ module: string }>
}) {
  const { module } = await params
  await requireAuth(`/settings/apps/${module}`)
  const permissions = await getEffectivePermissions()
  const canEditPictureSize = hasPermission(permissions, 'settings:apps:write')

  const isBase = module === 'base'
  const [initialOverride, base] = await Promise.all([
    getModulePictureSize(module),
    isBase ? Promise.resolve(null) : getModulePictureSize('base'),
  ])

  let displayName = module
  if (!isBase) {
    try {
      const record = await createServerApiClient().get<{ display_name: string }>('modules', module)
      displayName = record.display_name
    } catch (e) {
      toApiError(e) // degrade to the raw slug rather than failing the page
    }
  } else {
    displayName = 'Base'
  }

  // Sibling Containers rather than one shared wrapper: FormatSettings and
  // ViewsSettings are reused UNCHANGED from their old standalone pages, each
  // already bringing its own `Container maxWidth="md"` — nesting a second
  // Container around them would double their horizontal padding.
  return (
    <>
      <Container maxWidth="md" sx={{ pt: 6, pb: isBase ? 0 : 6 }}>
        <Stack spacing={4}>
          {/* The module's own display_name is DATA, never translated — same
              split as a catalog row's own title ("Base" is UI chrome, but
              this page is a Server Component with no t() available). */}
          <Typography variant="h4" component="h1">
            {displayName}
          </Typography>
          {!isBase ? (
            <PictureSizeSettings
              module={module}
              canEdit={canEditPictureSize}
              initialOverride={initialOverride}
              base={base}
            />
          ) : null}
        </Stack>
      </Container>

      {isBase ? (
        <>
          <FormatSettings canEdit={hasPermission(permissions, 'settings:format:write')} />
          <Container maxWidth="md" sx={{ py: 6 }}>
            <PictureSizeSettings
              module={module}
              canEdit={canEditPictureSize}
              initialOverride={initialOverride}
              base={base}
            />
          </Container>
        </>
      ) : (
        <ViewsSettingsSection module={module} canEdit={hasPermission(permissions, 'settings:views:write')} />
      )}
    </>
  )
}

async function ViewsSettingsSection({ module, canEdit }: { module: string; canEdit: boolean }) {
  const active = await activeModuleNames()

  const treeEntities = treeViewEntities().filter((e) => e.module === module && active.has(e.module))
  const rows: ViewEntityRow[] = await Promise.all(
    treeEntities.map(async (e) => ({ ...e, config: await getEntityViewFields(e.entity) })),
  )

  const formEntities = formViewEntities().filter((e) => e.module === module && active.has(e.module))
  const chatterRows: ChatterEntityRow[] = await Promise.all(
    formEntities.map(async (e) => ({
      entity: e.entity,
      moduleDefault: e.showChatterDefault,
      config: await getEntityChatterVisibility(e.entity),
    })),
  )

  return (
    <>
      <ViewsSettings rows={rows} canEdit={canEdit} />
      {chatterRows.length > 0 ? (
        <Container maxWidth="md" sx={{ pb: 6 }}>
          <ChatterSettings rows={chatterRows} canEdit={canEdit} />
        </Container>
      ) : null}
    </>
  )
}
