import { downloadCronHistoryLog, registerMenuAction, type FrontRoute, type MenuNode, type ViewDescriptor } from '@eerp/core-front'

// cron_history — one row per cron execution attempt, on the GENERIC CRUD
// surface (core/modules/cron/module.go) — see cron_views.ts's own doc
// comment for why both entities ride it (docs/adr/ADR-016-cron-scheduler.md).

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

export const cronHistoryRoutes: FrontRoute[] = [
  { path: '/cron_history', descriptor: cronHistoryListView, permission: 'cron_history:cron_history:read' },
  { path: '/cron_history/:id', descriptor: cronHistoryFormView, permission: 'cron_history:cron_history:read' },
]
