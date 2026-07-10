import {
  FORM_NOTEBOOK_ID,
  type FieldDescriptor,
  type FrontModule,
  type Operation,
  type ViewDescriptor,
} from '@eerp/core-front'

// App Store frontend — DESCRIPTORS ONLY (docs/roadmaps/app-store.md, Phase 3).
// entity 'modules' is a VIRTUAL entity: it maps to Go's dedicated
// /api/v1/modules API (internal/module, Phase 1), not a database table — but
// that API mimics the generic list/get/update envelope exactly (deliberately,
// ADR-level decision #4), so the generic server loader and ApiClient work
// unmodified for BOTH routes below. Field names are the raw module.json keys.

/** One record as Go's /api/v1/modules serves it — module.json content, read
 * only, plus the two virtual table fields this module's own extension adds. */
export interface AppStoreModule {
  id: string
  name: string
  display_name: string
  description?: string
  version: string
  author?: string
  type: string
  icon?: string
  active: boolean
  app_mode: boolean
  /** Seeded server-side by the hand-built host page (apps/shell/app/appstore/
   * [id]/page.tsx), never computed client-side — see the Views notebook page
   * Pitfall in the roadmap (a compute here would pull the server-only
   * moduleRegistry into the client bundle). */
  views?: { view: string; file: string; kind: 'Created' | 'Edited' }[]
  reports?: Record<string, unknown>[]
}

// ── catalog ('/appstore') ──────────────────────────────────────────────────

const catalogFields: ViewDescriptor['fields'] = [
  { name: 'icon', label: 'Icon', type: 'text' },
  { name: 'display_name', label: 'Display name', type: 'text' },
  { name: 'description', label: 'Description', type: 'text' },
]

const catalogView: ViewDescriptor = {
  entity: 'modules',
  viewType: 'catalog',
  fields: catalogFields,
  catalog: { icon: 'icon', title: 'display_name', subtitle: 'description' },
  formPath: '/appstore/:id',
  permissions: ['modules:modules:read'],
}

// ── form ('/appstore/:id') ───────────────────────────────────────────────────
// EVERY field is readOnly: true — this form has no editable field at all
// (docs/roadmaps/app-store.md, decision #6). display_name leads so it becomes
// the synthesized big TITLE (a human label, not the raw route-name `name`).
// `description` stays widget 'simple' (never 'long') on purpose: marking it
// 'long' would auto-route it onto the synthesized Settings page, which this
// form deliberately leaves EMPTY (decision #9 — Views/Reports lead instead).

const formFields: ViewDescriptor['fields'] = [
  { name: 'display_name', label: 'Display name', type: 'text', readOnly: true },
  { name: 'name', label: 'Name', type: 'text', readOnly: true },
  { name: 'description', label: 'Description', type: 'text', readOnly: true },
  { name: 'version', label: 'Version', type: 'text', readOnly: true },
  { name: 'author', label: 'Author', type: 'text', readOnly: true },
  { name: 'type', label: 'Type', type: 'text', readOnly: true },
  { name: 'icon', label: 'Icon', type: 'text', readOnly: true },
  { name: 'active', label: 'Active', type: 'boolean', readOnly: true },
  { name: 'app_mode', label: 'App mode', type: 'boolean', readOnly: true },
]

const formView: ViewDescriptor = {
  entity: 'modules',
  viewType: 'form',
  fields: formFields,
  permissions: ['modules:modules:read'],
}

// ── Views + Reports notebook pages (self-extension) ─────────────────────────
// A module may extend its OWN already-registered route (core/modules/crm's
// Signature page is the reference example) — no new extension operation
// needed: addField lands each virtual field in __form_columns first, then
// addNode EXTRACTS it into its own new notebook page.

const VIEWS_PAGE_ID = 'appstore_views_page'

const viewsField: FieldDescriptor = {
  name: 'views',
  label: 'Views',
  type: 'text',
  widget: 'table',
  store: false,
  widgetOptions: {
    columns: [
      { key: 'view', label: 'View' },
      { key: 'file', label: 'File' },
      { key: 'kind', label: 'Kind' },
    ],
  },
}

const reportsField: FieldDescriptor = {
  name: 'reports',
  label: 'Reports',
  type: 'text',
  widget: 'table',
  store: false,
  widgetOptions: {
    columns: [
      { key: 'report', label: 'Report' },
      { key: 'file', label: 'File' },
    ],
    emptyLabel: 'Reports are not available yet.',
  },
}

const notebookOperations: Operation[] = [
  { op: 'addField', field: viewsField },
  { op: 'addField', field: reportsField },
  {
    op: 'addNode',
    node: { kind: 'page', id: VIEWS_PAGE_ID, title: 'Views', children: [{ kind: 'field', name: 'views' }] },
    target: FORM_NOTEBOOK_ID,
    position: 'first',
  },
  {
    op: 'addNode',
    node: { kind: 'page', title: 'Reports', children: [{ kind: 'field', name: 'reports' }] },
    target: VIEWS_PAGE_ID,
    position: 'after',
  },
]

const appstore: FrontModule = {
  name: 'appstore',
  routes: [
    { path: '/appstore', descriptor: catalogView, permission: 'modules:modules:read' },
    { path: '/appstore/:id', descriptor: formView, permission: 'modules:modules:read' },
  ],
  // Self-targeting: ModuleRegistry.register() applies `extends` right after
  // this SAME call's `routes`, so '/appstore/:id' already exists.
  extends: [{ path: '/appstore/:id', operations: notebookOperations }],
}

export default appstore
