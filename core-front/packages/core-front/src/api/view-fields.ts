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
}

export const EMPTY_VIEW_FIELDS: ViewFieldsConfig = {
  kanbanStatusField: null,
  calendarDateField: null,
  enableGraphs: null,
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
}

/** The fully-resolved (module default, then admin override) view-mode config
 * a renderer actually acts on — never ambiguous about "unset". */
export interface EffectiveViewFields {
  kanbanStatusField: string | null
  calendarDateField: string | null
  enableGraphs: boolean
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
  }
}

/** The list view's display-mode switcher (top-right of the list). */
export type DisplayMode = 'list' | 'kanban' | 'calendar' | 'graph'

export const DISPLAY_MODES: readonly DisplayMode[] = ['list', 'kanban', 'calendar', 'graph']

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
  }
}
