import { notFound } from 'next/navigation'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { hasPermission, T } from '@eerp/core-front'
import { activeModuleNames } from '@/lib/module-state'
import { getEffectivePermissions, requireAuth } from '@/lib/session'
import { loadWorkflowPages } from '@/website/workflow-pages'
import { LazyWorkflowMap } from './LazyWorkflowMap'

// Website app → Workflows: a map of the site's pages and the buttons between them
// (hand-built page, linked from the Website dashboard's `dashboardLinks` tile).
export default async function WorkflowsPage() {
  await requireAuth('/website/workflows')
  const [active, permissions] = await Promise.all([activeModuleNames(), getEffectivePermissions()])
  if (!active.has('website') || !hasPermission(permissions, 'website_page:website_page:read')) notFound()
  const pages = await loadWorkflowPages()
  return (
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Stack spacing={0.5}>
          <Typography variant="h4" component="h1"><T text="Workflows" /></Typography>
          <Typography color="text.secondary">
            <T text="Click a page to open it in the builder. Drag the end of an arrow onto another page to change where that button leads." />
          </Typography>
        </Stack>
        <LazyWorkflowMap pages={pages} />
      </Stack>
    </Container>
  )
}
