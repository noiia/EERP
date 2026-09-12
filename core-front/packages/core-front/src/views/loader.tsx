import 'server-only'
import { ApiError, serializeError, type SerializedError } from '../api/errors'
import { createServerApiClient, type ServerApiClient } from '../api/ApiClient'
import { EMPTY_VIEW_FIELDS, type ViewFieldsConfig } from '../api/view-fields'
import { effectiveChatterVisible, type ChatterVisibilityConfig } from '../api/chatter-visibility'
import type { EntityListOptions } from '../api/list-options'
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
  /**
   * Go's server-side row count, when known (tree/dashboard-list views only —
   * form loads a single record and has no "total"). Graph mode's aggregate
   * widgets (docs/roadmaps/list-view-modes.md, Phase 5) compare this against
   * `initialData.length` to detect a page_size-truncated fetch rather than
   * silently aggregating a partial set.
   */
  total?: number
}

export interface LoadViewOptions {
  /** For a form view: the record id to edit. Absent / "new" means a create form. */
  recordId?: string
  /**
   * Server-side row filter/search for a tree/dashboard-list load — the same
   * `filter[col]=`/`search[col]=` refinement the generic list endpoint
   * already accepts (relation widgets use this today; a settings page
   * scoping a list by the caller's active company, e.g.
   * report_page_format's Settings -> Global settings -> Reports list, is
   * the other use). Ignored for a form view (single-record fetch).
   */
  listOptions?: EntityListOptions
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
    // descriptor.listFilter (a route-fixed refinement) always applies, ahead
    // of whatever the caller passed — a host page's own listOptions can add
    // to it (e.g. more filter/search keys) but never has to know it exists.
    const mergedOptions: EntityListOptions | undefined =
      descriptor.listFilter || options.listOptions
        ? {
            ...descriptor.listFilter,
            ...options.listOptions,
            filter: { ...descriptor.listFilter?.filter, ...options.listOptions?.filter },
          }
        : undefined
    const { records, total } = await api.listWithTotal<T>(descriptor.entity, mergedOptions)
    return { initialData: records, error: null, total }
  } catch (e) {
    if (e instanceof ApiError) return { initialData: [], error: serializeError(e) }
    throw e
  }
}

/**
 * The entity's Kanban/Calendar field config, for the list view's display-mode
 * switcher (docs/roadmaps/list-view-modes.md). An unreadable config (session
 * hiccup, missing settings:views:read) degrades to the empty/unconfigured
 * state rather than failing the whole view — Kanban/Calendar just stay
 * disabled, same posture as an unconfigured entity.
 */
export async function loadViewFields(
  entity: string,
  api: ServerApiClient = createServerApiClient(),
): Promise<ViewFieldsConfig> {
  try {
    return await api.getViewFields(entity)
  } catch (e) {
    if (e instanceof ApiError) return EMPTY_VIEW_FIELDS
    throw e
  }
}

/**
 * entity's admin-configured chatter-panel visibility override (Settings ->
 * Apps -> :module, "Form chatter panel" row). An unreadable config (session
 * hiccup, missing settings:views:read) degrades to "no override" rather than
 * failing the whole form — see effectiveChatterVisible for how this merges
 * with the entity's own ViewDescriptor.showChatter.
 */
export async function loadChatterVisibility(
  entity: string,
  api: ServerApiClient = createServerApiClient(),
): Promise<ChatterVisibilityConfig> {
  try {
    return await api.getChatterVisibility(entity)
  } catch (e) {
    if (e instanceof ApiError) return { enabled: null }
    throw e
  }
}

/**
 * The boolean/picture widget's effective box size for a form's owning module
 * (Settings -> Apps): that module's own override if it declared one, else the
 * workspace-wide Base value, else `null` — "no admin setting at any level",
 * which the widget then resolves against its own `widgetOptions`/hardcoded
 * default (a lower-precedence tier this loader knows nothing about). An
 * unreadable setting (session hiccup, missing settings:apps:read) degrades to
 * null rather than failing the form, same posture as loadViewFields.
 */
export async function loadPictureSize(
  module: string,
  api: ServerApiClient = createServerApiClient(),
): Promise<{ width: number; height: number } | null> {
  try {
    const [override, base] = await Promise.all([api.getPictureSize(module), api.getPictureSize('base')])
    return override ?? base
  } catch (e) {
    if (e instanceof ApiError) return null
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
  /**
   * The route's owning module (the catch-all already resolves this via
   * `resolveModuleRoute`) — used only to fetch the Settings -> Apps picture-
   * size cascade for a form view. Absent (e.g. the Settings -> Users pages,
   * which reuse this engine outside the module catch-all) just skips that
   * fetch, same as an entity with no picture field.
   */
  module?: string
  /** Server-side row filter/search for a tree/dashboard list — see LoadViewOptions. */
  listOptions?: EntityListOptions
  /** Passed straight through to `EntityViewProps.title` — see its own doc
   * comment (renderers.tsx). Tree views only; every other viewType ignores it. */
  title?: string
}

export async function EntityViewServer<T extends HasId>({
  descriptor,
  actions,
  api,
  recordId,
  listViews,
  module,
  listOptions,
  title,
}: EntityViewServerProps<T>) {
  const client = api ?? createServerApiClient()
  const { initialData, error, total } = await loadView(descriptor, client, { recordId, listOptions })
  // A dashboard rolls the module's list views up into count blocks; other views ignore it.
  const widgets =
    descriptor.viewType === 'dashboard' && listViews?.length
      ? await loadDashboardWidgets(listViews, client)
      : undefined
  // The display-mode switcher (List/Kanban/Calendar/Graph) only applies to tree
  // views; other viewTypes never read this.
  const viewFields =
    descriptor.viewType === 'tree' ? await loadViewFields(descriptor.entity, client) : undefined
  // Only a form with an actual picture field needs the size cascade — skip the
  // round trips otherwise, same "only fetch what's needed" discipline as above.
  const hasPictureField = descriptor.fields.some((f) => f.type === 'boolean' && f.widget === 'picture')
  const pictureSize =
    descriptor.viewType === 'form' && module && hasPictureField
      ? await loadPictureSize(module, client)
      : undefined
  // Every form view is a chatter candidate — unlike pictureSize, there's no
  // "has the relevant field" gate here, since the panel is keyed on the
  // entity/record, not a specific field.
  const chatterVisible =
    descriptor.viewType === 'form'
      ? effectiveChatterVisible(descriptor.showChatter, await loadChatterVisibility(descriptor.entity, client))
      : undefined
  return (
    <EntityView
      descriptor={descriptor}
      initialData={initialData}
      actions={actions}
      error={error}
      widgets={widgets}
      viewFields={viewFields}
      recordTotal={total}
      pictureSize={pictureSize}
      chatterVisible={chatterVisible}
      title={title}
    />
  )
}
