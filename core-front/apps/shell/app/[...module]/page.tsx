import { notFound } from 'next/navigation'
import Box from '@mui/material/Box'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { EntityViewServer } from '@eerp/core-front/server'
import { CreateBar, T, type EntityActions, type ViewDescriptor } from '@eerp/core-front'
// Side-effect import: registers every discovered module's FrontModule into the shared
// registry before we resolve the route. Regenerated at build time (gitignored).
import '@/generated/generated-modules'
import { requireAuth } from '@/lib/session'
import { createRecord, removeRecord, updateRecord } from './actions'
import {
  dashboardListViews,
  modulePageTitle,
  modulePathFromSegments,
  resolveModuleRoute,
} from './resolve'

// The view engine dispatches dynamically off the descriptor, so records are opaque
// here — the minimal HasId shape is all the engine needs at this boundary.
type AnyRecord = { id: string } & Record<string, unknown>

interface ModulePageProps {
  params: Promise<{ module?: string[] }>
}

export default async function ModulePage({ params }: ModulePageProps) {
  const { module: segments = [] } = await params

  // RequireAuth: module routes require a session (anon -> /login). Fine-grained
  // permission authorization is enforced by Go on every data call (the route's
  // descriptor permission re-enters the frontend gate once permissions are exposed).
  await requireAuth(modulePathFromSegments(segments))

  const match = resolveModuleRoute(segments)
  if (!match) notFound()
  const { route, params: routeParams } = match

  const { entity } = route.descriptor
  // Bound Server Actions are serializable references the client form store can call.
  const actions = {
    create: createRecord.bind(null, entity),
    update: updateRecord.bind(null, entity),
    remove: removeRecord.bind(null, entity),
  } as unknown as EntityActions<AnyRecord>

  // A dashboard rolls the owning module's list views into count blocks; other views ignore this.
  const listViews =
    route.descriptor.viewType === 'dashboard' ? dashboardListViews(route.module) : undefined

  return (
    // maxWidth={false}: RootLayout's pageInsetX/pageInsetY (10% of the viewport per
    // axis) is already the page's width bound — MUI's own default "lg" (1200px) cap
    // would just re-narrow list/kanban/calendar/graph views a second time, wasting
    // the space the inset was meant to hand them. Forms don't need this override:
    // FormRenderer self-limits to layout.formMaxWidth regardless of the container.
    <Container maxWidth={false} sx={{ py: 4 }}>
      <Stack spacing={3}>
        {/* The title is computed here (RSC) but the locale is client state, so the
            <T> leaf translates it at the client boundary. Tree views carry their
            Create button on this same row, right-aligned (the engine's CreateBar
            hides itself without the permission). */}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
          <Typography variant="h4" component="h1">
            <T text={modulePageTitle(segments, routeParams)} />
          </Typography>
          {route.descriptor.viewType === 'tree' ? (
            <CreateBar descriptor={route.descriptor as ViewDescriptor<AnyRecord>} />
          ) : null}
        </Box>
        <EntityViewServer
          descriptor={route.descriptor as ViewDescriptor<AnyRecord>}
          actions={actions}
          recordId={routeParams.id}
          listViews={listViews}
        />
      </Stack>
    </Container>
  )
}
