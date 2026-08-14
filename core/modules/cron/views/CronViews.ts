import {
  downloadCronHistoryLog,
  registerMenuAction,
  type FrontModule,
  type MenuNode,
  type ViewDescriptor,
} from '@eerp/core-front'

// Cron frontend — DESCRIPTORS ONLY (same discipline as core/modules/crm's
// CrmViews.ts). Two entities, both on the GENERIC CRUD surface (see
// core/modules/cron/module.go): 'cron' (the scheduled action itself) and
// 'cron_history' (one row per execution attempt). Riding the generic
// surface is what gives 'cron' its List/Kanban/Calendar/Graph views for
// free through the standard engine — no custom list/kanban/calendar
// component was written for this feature (docs/adr/ADR-016-cron-scheduler.md).

/** The Cron record as served by Go's /cron endpoints (BaseModel + business fields). */
export interface Cron {
  id: string
  name: string
  /** Names a registered core/internal/cron.Action by id — see action_code. */
  action_id?: string
  /** Read-only: the resolved Action's Go source, populated server-side
   * (core/modules/cron/handler.go's Create/Update override) whenever
   * action_id is set — never edited here. */
  action_code?: string
  /** ISO datetime; the scheduler clears this back to null once it has run. */
  execution_date?: string | null
  /** One of the selection field's options: deactivated/active/archived. */
  status?: string
  run_as_user_id?: string | null
  /** Years of cron_history this cron's own runs survive before the
   * retention sweep removes them; 0/unset = the sweep's own default (1). */
  history_retention_years?: number
}

/** The CronHistory record as served by Go's /cron_history endpoints. */
export interface CronHistoryRecord {
  id: string
  cron_id: string
  /** true ⇒ this run errored (unknown action, missing run-as-user
   * permission, or the action's own Run returning an error) — the
   * calendar's calendarColorField highlights these red. */
  failed?: boolean
  logs_filepath?: string
  created_at?: string
}

const cronListFields: ViewDescriptor['fields'] = [
  { name: 'name', label: 'Name', type: 'text', required: true },
  { name: 'action_id', label: 'Action', type: 'text', required: true },
  { name: 'execution_date', label: 'Execution date', type: 'date' },
  {
    name: 'status',
    label: 'Status',
    type: 'selection',
    // Declared order is Kanban's own column order — "archived" trailing
    // last is the closest available approximation of "hidden by default"
    // (the engine's Kanban has no per-column visibility toggle today; see
    // docs/adr/ADR-016-cron-scheduler.md's Deliberate cuts section).
    selection: { options: ['deactivated', 'active', 'archived'] },
  },
]

// Relation/detail fields render on the FORM only — same split CrmViews.ts's
// fields/formFields makes, for the same reason (the list DataGrid has no
// good way to show a relation FK or a long code blob).
const cronFormFields: ViewDescriptor['fields'] = [
  ...cronListFields,
  {
    name: 'run_as_user_id',
    label: 'Run as',
    type: 'relation',
    // Users carries no separate display-name column (core/CLAUDE.md's
    // internal/settings note) — email is the closest thing to one.
    relation: { entity: 'users', kind: 'many2one', labelField: 'email' },
  },
  {
    name: 'history_retention_years',
    label: 'History retention (years)',
    type: 'number',
    widget: 'int',
  },
  {
    // widget: 'long' is what lands this on the synthesized form's notebook
    // FIRST page (normalizeLayout's synthesizeFormLayout puts every `long`
    // field there, in declaration order — this is the only one) — no
    // explicit `layout` needed to satisfy "in the first page of notebook a
    // read-only display of the executed code."
    name: 'action_code',
    label: 'Code',
    type: 'text',
    widget: 'long',
    readOnly: true,
  },
  {
    // Read-only embedded grid of this cron's own past runs — the natural
    // way to reach a cron's history without a separate top-level menu
    // entry (cron_history has no app_mode tile). Virtual: never part of
    // the cron commit payload.
    name: 'history',
    label: 'History',
    type: 'relation',
    relation: { entity: 'cron_history', kind: 'one2many', inverseField: 'cron_id', labelField: 'created_at' },
  },
]

const listView: ViewDescriptor = {
  entity: 'cron',
  viewType: 'tree',
  fields: cronListFields,
  formPath: '/cron/:id',
  createPermission: 'cron:cron:write',
  permissions: ['cron:cron:read'],
  viewModeDefaults: { kanbanStatusField: 'status', calendarDateField: 'execution_date' },
}

const formView: ViewDescriptor = {
  entity: 'cron',
  viewType: 'form',
  fields: cronFormFields,
  permissions: ['cron:cron:read'],
}

const cronHistoryFields: ViewDescriptor['fields'] = [
  {
    name: 'cron_id',
    label: 'Cron',
    type: 'relation',
    relation: { entity: 'cron', kind: 'many2one', labelField: 'name' },
    readOnly: true,
  },
  { name: 'created_at', label: 'Ran at', type: 'date', readOnly: true },
  { name: 'failed', label: 'Failed', type: 'boolean', readOnly: true },
  { name: 'logs_filepath', label: 'Log file', type: 'text', readOnly: true },
]

const cronHistoryActions: MenuNode[] = [
  { kind: 'action', label: 'Download log', action: 'cron_history.downloadLog' },
]

registerMenuAction({
  entity: 'cron_history',
  name: 'cron_history.downloadLog',
  handler: ({ recordId }) => downloadCronHistoryLog(recordId),
})

const cronHistoryListView: ViewDescriptor = {
  entity: 'cron_history',
  viewType: 'tree',
  fields: cronHistoryFields,
  formPath: '/cron_history/:id',
  // No createPermission: history rows are written only by the scheduler,
  // never user-created — omitting it hides the Create button entirely
  // (default-closed, per the engine's own convention).
  permissions: ['cron_history:cron_history:read'],
  viewModeDefaults: { calendarDateField: 'created_at', calendarColorField: 'failed' },
}

const cronHistoryFormView: ViewDescriptor = {
  entity: 'cron_history',
  viewType: 'form',
  fields: cronHistoryFields,
  permissions: ['cron_history:cron_history:read'],
  actions: cronHistoryActions,
}

const cron: FrontModule = {
  name: 'cron',
  routes: [
    { path: '/cron', descriptor: listView, permission: 'cron:cron:read' },
    { path: '/cron/:id', descriptor: formView, permission: 'cron:cron:read' },
    { path: '/cron_history', descriptor: cronHistoryListView, permission: 'cron_history:cron_history:read' },
    { path: '/cron_history/:id', descriptor: cronHistoryFormView, permission: 'cron_history:cron_history:read' },
  ],
}

export default cron
