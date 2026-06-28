import 'server-only'
import { ApiError, serializeError, type SerializedError } from '../api/errors'
import { createServerApiClient, type ServerApiClient } from '../api/ApiClient'
import type { ViewDescriptor } from './descriptor'
import { EntityView } from './renderers'
import type { EntityActions, HasId, Widget } from './stores'

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

/** A list view a dashboard rolls up into a block: its entity, heading, and link. */
export interface DashboardListView {
  /** Drives the count query (api.list) — maps straight to the Go route group. */
  entity: string
  /** Block heading shown in bold. */
  title: string
  /** Where the block links to (the list view's path). */
  href: string
}

/**
 * Build the dashboard blocks: one per list view in the module, each carrying its current
 * entry count. Counts come from the same cached server reads the list views use, so a
 * dashboard is a free rollup of data already fetched elsewhere. A per-view load error
 * leaves that block's count null (rendered as a dash) rather than failing the dashboard.
 */
export async function loadDashboardWidgets(
  listViews: DashboardListView[],
  api: ServerApiClient = createServerApiClient(),
): Promise<Widget[]> {
  return Promise.all(
    listViews.map(async (view) => {
      try {
        const records = await api.list(view.entity)
        return { id: view.href, title: view.title, href: view.href, count: records.length }
      } catch (e) {
        if (e instanceof ApiError) return { id: view.href, title: view.title, href: view.href, count: null }
        throw e
      }
    }),
  )
}

export interface EntityViewServerProps<T extends HasId> {
  descriptor: ViewDescriptor<T>
  /** Server Actions for this entity, passed through to the client renderer. */
  actions: EntityActions<T>
  api?: ServerApiClient
  /** Record id for a form view (from the route's :id param). */
  recordId?: string
  /** The owning module's list views — rolled up into blocks for a dashboard view. */
  listViews?: DashboardListView[]
}

export async function EntityViewServer<T extends HasId>({
  descriptor,
  actions,
  api,
  recordId,
  listViews,
}: EntityViewServerProps<T>) {
  const client = api ?? createServerApiClient()
  const { initialData, error } = await loadView(descriptor, client, { recordId })
  // A dashboard rolls the module's list views up into count blocks; other views ignore it.
  const widgets =
    descriptor.viewType === 'dashboard' && listViews?.length
      ? await loadDashboardWidgets(listViews, client)
      : undefined
  return (
    <EntityView
      descriptor={descriptor}
      initialData={initialData}
      actions={actions}
      error={error}
      widgets={widgets}
    />
  )
}
