import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { createServerApiClient } from '@eerp/core-front/server'
import { requireAuth } from '@/lib/session'
import AppsList, { type AppListRow } from '@/components/AppsList'

// Settings -> Apps: the list of installed applications, each linking to its
// own settings form. A pinned, synthetic "Base" row sits first — not a real
// module, it holds the workspace-wide defaults every app inherits unless it
// overrides them (docs: Settings -> Apps' Base/override cascade).
//
// Sourced straight from Go's existing GET /api/v1/modules (the App Store's
// own data — display_name/icon/description, live active state), filtered to
// app_mode:true: the same set of apps a user sees as tiles on the landing
// menu. Hand-built rather than the generic `catalog` viewType/CatalogRenderer
// on purpose: that engine contract has no row-filter concept, and every other
// Settings page here (Views, Formats, Users) is already hand-built for the
// same reason. The actual row list is AppsList (a Client Component — see its
// own comment for why: `ListItemButton component={Link}` can't cross the
// Server/Client boundary as a prop from this page).

interface ModuleLite {
  name: string
  display_name: string
  description?: string
  icon?: string
  app_mode: boolean
}

const BASE_ROW: AppListRow = {
  name: 'base',
  display_name: 'Base',
  description: 'Default settings every app inherits unless it overrides them.',
  icon: '⚙️',
}

export default async function AppsSettingsPage() {
  await requireAuth('/settings/apps')

  const modules = await createServerApiClient().list<ModuleLite>('modules')
  const apps: AppListRow[] = [BASE_ROW, ...modules.filter((m) => m.app_mode)]

  return (
    <Container maxWidth="md" sx={{ py: 6 }}>
      <Stack spacing={3}>
        <Stack spacing={1}>
          <Typography variant="h4" component="h1">
            <T text="Apps" />
          </Typography>
          <Typography color="text.secondary">
            <T text="Installed applications and their settings." />
          </Typography>
        </Stack>
        <AppsList apps={apps} />
      </Stack>
    </Container>
  )
}
