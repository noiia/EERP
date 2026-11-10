// Kanban/Calendar/Graph mode configuration (docs/roadmaps/list-view-modes.md,
// ADR-006 and its module-defaults amendment). WHICH field is an entity's
// Kanban status field or Calendar date field, and whether Graph mode is on,
// is admin-configured runtime state — so the OVERRIDE lives here, next to
// EntityListOptions, as data the server ApiClient reads/writes rather than as
// a ViewDescriptor property. A module MAY additionally declare a hardcoded
// BASELINE for these three (`ViewDescriptor.viewModeDefaults`, descriptor.ts)
// — effectiveViewFields merges the two, override winning field-by-field, so
// "admin-configured, module-defaulted" is one small pure function rather than
// two competing sources of truth. Client-safe (no 'server-only' import) so
// both the engine's renderers and the shell's Settings -> Views page can
// import it.

/** Server state: app_settings key `views.<entity>.fields`, mirrored camelCase
 * client-side. A null field means "no workspace override" — NOT "disabled";
 * effectiveViewFields falls back to the entity's own ViewModeDefaults (a
 * module's hardcoded baseline) before landing on disabled. */
export interface ViewFieldsConfig {
  kanbanStatusField: string | null
  calendarDateField: string | null
  /** null = no override (inherit the module's default, or disabled if it
   * declared none); true/false forces Graph mode on/off either way. */
  enableGraphs?: boolean | null
  /** Gantt bar start/end date fields; Gantt mode needs both to resolve. */
  ganttStartField?: string | null
  ganttEndField?: string | null
}

export const EMPTY_VIEW_FIELDS: ViewFieldsConfig = {
  kanbanStatusField: null,
  calendarDateField: null,
  enableGraphs: null,
  ganttStartField: null,
  ganttEndField: null,
}

/**
 * A module's own hardcoded baseline for its tree view's Kanban/Calendar/Graph
 * modes (`ViewDescriptor.viewModeDefaults`) — the value Settings -> Views
 * shows before any admin override, and what a "revert to module settings"
 * action restores. Omitted entirely, or a field left unset, means the module
 * declared no opinion for that mode: it stays unavailable until an admin
 * configures it, exactly like before this existed.
 */
export interface ViewModeDefaults {
  kanbanStatusField?: string
  calendarDateField?: string
  enableGraphs?: boolean
  ganttStartField?: string
  ganttEndField?: string
  /**
   * Names a `type: 'boolean'` field: when a record's value is true, the
   * Calendar renderer highlights its card red (e.g. cron_history's `failed`
   * — "if a cron has failed, display it as red" — docs/adr/ADR-016-cron-
   * scheduler.md). Module-declared only, no runtime admin override exists
   * for this one (unlike kanbanStatusField/calendarDateField) — it is a
   * fixed semantic ("true means highlight"), not a workspace preference.
   */
  calendarColorField?: string
  /**
   * Builds the Kanban columns from the RECORDS of a many2one status field's
   * related entity (Odoo-style editable stages) instead of selection options.
   * Only used when the effective status field is a many2one relation.
   * Module-declared only, like calendarColorField.
   */
  kanbanColumns?: KanbanColumnsConfig
  /** Names a `type: 'boolean'` field: a Kanban card whose value is true shows
   * an error-colored chip labeled with that field's label. Module-declared only. */
  kanbanBadgeField?: string
  /** Gantt dependency arrows, read from the rows of another entity.
   * Module-declared only, like calendarColorField. */
  ganttDependencies?: GanttDependenciesConfig
}

/** Rows of `entity` link record `fromField` (the blocker: the arrow leaves
 * its bar's end) to record `toField` (the dependent: the arrow reaches its
 * bar's start). */
export interface GanttDependenciesConfig {
  entity: string
  fromField: string
  toField: string
}

/** How a many2one status field's related records become Kanban columns. */
export interface KanbanColumnsConfig {
  /** Column order, e.g. 'sequence'. */
  orderField: string
  /** Column title, e.g. 'name'. */
  labelField: string
  /** Truthy ⇒ the column renders collapsed, e.g. 'closed'. */
  foldField?: string
  /** Same column name on the card entity AND the column entity, e.g. 'project_id'. */
  scopeField?: string
  /** Name registered with registerKanbanColumnsGuard: may the caller edit this scope's columns? */
  canEdit?: string
}

/** The fully-resolved (module default, then admin override) view-mode config
 * a renderer actually acts on — never ambiguous about "unset". */
export interface EffectiveViewFields {
  kanbanStatusField: string | null
  calendarDateField: string | null
  enableGraphs: boolean
  calendarColorField: string | null
  kanbanColumns: KanbanColumnsConfig | null
  kanbanBadgeField: string | null
  ganttStartField: string | null
  ganttEndField: string | null
  ganttDependencies: GanttDependenciesConfig | null
}

/**
 * Merges an admin's stored override (`ViewFieldsConfig`, null field = "not
 * overridden") over a module's own hardcoded `ViewModeDefaults`. The module's
 * value is the baseline; a non-null override always wins over it.
 */
export function effectiveViewFields(
  defaults: ViewModeDefaults | undefined,
  config: ViewFieldsConfig,
): EffectiveViewFields {
  return {
    kanbanStatusField: config.kanbanStatusField ?? defaults?.kanbanStatusField ?? null,
    calendarDateField: config.calendarDateField ?? defaults?.calendarDateField ?? null,
    enableGraphs: config.enableGraphs ?? defaults?.enableGraphs ?? false,
    calendarColorField: defaults?.calendarColorField ?? null,
    kanbanColumns: defaults?.kanbanColumns ?? null,
    kanbanBadgeField: defaults?.kanbanBadgeField ?? null,
    ganttStartField: config.ganttStartField ?? defaults?.ganttStartField ?? null,
    ganttEndField: config.ganttEndField ?? defaults?.ganttEndField ?? null,
    ganttDependencies: defaults?.ganttDependencies ?? null,
  }
}

/** The list view's display-mode switcher (top-right of the list). */
export type DisplayMode = 'list' | 'kanban' | 'calendar' | 'graph' | 'gantt'

export const DISPLAY_MODES: readonly DisplayMode[] = ['list', 'kanban', 'calendar', 'graph', 'gantt']

/**
 * Which modes are usable right now for a given entity's EFFECTIVE (module
 * default merged with admin override) config. `list` needs no configuration;
 * `kanban`/`calendar`/`graph` stay unavailable — the switcher hides them
 * entirely, not just disables them — until a field/flag resolves truthy,
 * whether that came from the module's own default or Settings -> Views.
 */
export function availableDisplayModes(effective: EffectiveViewFields): Record<DisplayMode, boolean> {
  return {
    list: true,
    kanban: effective.kanbanStatusField != null,
    calendar: effective.calendarDateField != null,
    graph: effective.enableGraphs,
    gantt: effective.ganttStartField != null && effective.ganttEndField != null,
  }
}
