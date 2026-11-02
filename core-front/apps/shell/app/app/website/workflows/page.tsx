import { notFound } from 'next/navigation'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { hasPermission, T } from '@eerp/core-front'
import { activeModuleNames } from '@/lib/module-state'
import { getEffectivePermissions, requireAuth } from '@/lib/session'
import { getWorkflowPositions } from '@/website/editor-actions'
import { loadWorkflowPages } from '@/website/workflow-pages'
import { LazyWorkflowMap } from './LazyWorkflowMap'

// Website app → Workflows: a map of the site's pages and the buttons between them
// (hand-built page, linked from the Website dashboard's `dashboardLinks` tile).
export default async function WorkflowsPage() {
  await requireAuth('/website/workflows')
  const [active, permissions] = await Promise.all([activeModuleNames(), getEffectivePermissions()])
  if (!active.has('website') || !hasPermission(permissions, 'website_page:website_page:read')) notFound()
  const [pages, positions] = await Promise.all([loadWorkflowPages(), getWorkflowPositions()])
  // Links live in the pages' layouts; box positions in a website setting.
  const canEdit = hasPermission(permissions, 'website_page:website_page:write')
  const canArrange = hasPermission(permissions, 'settings:website:write')
  return (
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Stack spacing={0.5}>
          <Typography variant="h4" component="h1"><T text="Workflows" /></Typography>
          <Typography color="text.secondary">
            <T text="Click a page to open it in the builder. Drag a box to move it, drag from the dot on its right onto another page to add a link, or drag the end of an arrow to change where it leads. Select an arrow to remove it." />
          </Typography>
        </Stack>
        <LazyWorkflowMap pages={pages} positions={positions} canEdit={canEdit} canArrange={canArrange} />
      </Stack>
    </Container>
  )
}
