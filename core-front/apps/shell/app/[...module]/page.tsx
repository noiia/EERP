import { notFound } from 'next/navigation'
import { EntityViewServer, requirePermission } from '@eerp/core-front/server'
import type { EntityActions, ViewDescriptor } from '@eerp/core-front'
// Side-effect import: registers every discovered module's FrontModule into the shared
// registry before we resolve the route. Regenerated at build time (gitignored).
import '../../src/generated/generated-modules'
import { getEffectivePermissions } from '../../src/lib/session'
import { createRecord, removeRecord, updateRecord } from './actions'
import { resolveModuleRoute } from './resolve'

// The view engine dispatches dynamically off the descriptor, so records are opaque
// here — the minimal HasId shape is all the engine needs at this boundary.
type AnyRecord = { id: string } & Record<string, unknown>

interface ModulePageProps {
  params: Promise<{ module?: string[] }>
}

export default async function ModulePage({ params }: ModulePageProps) {
  const { module: segments = [] } = await params
  const route = resolveModuleRoute(segments)
  if (!route) notFound()

  // Server authorizes (the client <Can> only gates UI). Denial redirects to /login.
  if (route.permission) {
    requirePermission(await getEffectivePermissions(), route.permission, { redirectTo: '/login' })
  }

  const { entity } = route.descriptor
  // Bound Server Actions are serializable references the client form store can call.
  const actions = {
    create: createRecord.bind(null, entity),
    update: updateRecord.bind(null, entity),
    remove: removeRecord.bind(null, entity),
  } as unknown as EntityActions<AnyRecord>

  return <EntityViewServer descriptor={route.descriptor as ViewDescriptor<AnyRecord>} actions={actions} />
}
