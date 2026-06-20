import { notFound } from 'next/navigation'
import { EntityViewServer } from '@eerp/core-front/server'
import type { EntityActions, ViewDescriptor } from '@eerp/core-front'
// Side-effect import: registers every discovered module's FrontModule into the shared
// registry before we resolve the route. Regenerated at build time (gitignored).
import '@/generated/generated-modules'
import { requireAuth } from '@/lib/session'
import { createRecord, removeRecord, updateRecord } from './actions'
import { modulePathFromSegments, resolveModuleRoute } from './resolve'

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

  const route = resolveModuleRoute(segments)
  if (!route) notFound()

  const { entity } = route.descriptor
  // Bound Server Actions are serializable references the client form store can call.
  const actions = {
    create: createRecord.bind(null, entity),
    update: updateRecord.bind(null, entity),
    remove: removeRecord.bind(null, entity),
  } as unknown as EntityActions<AnyRecord>

  return <EntityViewServer descriptor={route.descriptor as ViewDescriptor<AnyRecord>} actions={actions} />
}
