import 'server-only'
import { ApiError, serializeError, type SerializedError } from '../api/errors'
import { createServerApiClient, type ServerApiClient } from '../api/ApiClient'
import type { ViewDescriptor } from './descriptor'
import { EntityView } from './renderers'
import type { EntityActions, HasId } from './stores'

// Server side of the view engine. loadView fetches the descriptor's data through the
// server ApiClient (Next Data Cache, tagged by entity) and folds any ApiError into a
// serializable shape. EntityViewServer is the RSC the catch-all route renders: it
// loads on the server, then hands a seeded, client EntityView to the browser.

export interface LoadedView<T> {
  initialData: T[]
  error: SerializedError | null
}

export interface LoadViewOptions {
  /** For a form view: the record id to edit. Absent / "new" means a create form. */
  recordId?: string
}

export async function loadView<T extends HasId>(
  descriptor: ViewDescriptor<T>,
  api: ServerApiClient = createServerApiClient(),
  options: LoadViewOptions = {},
): Promise<LoadedView<T>> {
  try {
    // A form keyed by id seeds with that single record; a create form seeds empty.
    // Tree/dashboard views seed with the entity list.
    if (descriptor.viewType === 'form') {
      const { recordId } = options
      if (!recordId || recordId === 'new') return { initialData: [], error: null }
      return { initialData: [await api.get<T>(descriptor.entity, recordId)], error: null }
    }
    return { initialData: await api.list<T>(descriptor.entity), error: null }
  } catch (e) {
    if (e instanceof ApiError) return { initialData: [], error: serializeError(e) }
    throw e
  }
}

export interface EntityViewServerProps<T extends HasId> {
  descriptor: ViewDescriptor<T>
  /** Server Actions for this entity, passed through to the client renderer. */
  actions: EntityActions<T>
  api?: ServerApiClient
  /** Record id for a form view (from the route's :id param). */
  recordId?: string
}

export async function EntityViewServer<T extends HasId>({
  descriptor,
  actions,
  api,
  recordId,
}: EntityViewServerProps<T>) {
  const { initialData, error } = await loadView(descriptor, api ?? createServerApiClient(), { recordId })
  return <EntityView descriptor={descriptor} initialData={initialData} actions={actions} error={error} />
}
