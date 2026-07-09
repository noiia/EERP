// Kanban/Calendar field configuration (docs/roadmaps/list-view-modes.md,
// ADR-006). Unlike every other per-field concern in this codebase (widget,
// states, compute), WHICH field is an entity's Kanban status field or
// Calendar date field is admin-configured runtime state, not something a
// module author commits in a descriptor — so it lives here, next to
// EntityListOptions, as data the server ApiClient reads/writes rather than
// as a ViewDescriptor property. Client-safe (no 'server-only' import) so both
// the engine's renderers and the shell's Settings -> Views page can import it.

/** Server state: app_settings key `views.<entity>.fields`, mirrored camelCase
 * client-side. Absent config (both fields null) is a normal, unconfigured
 * state — not an error; the mode switcher just keeps Kanban/Calendar disabled. */
export interface ViewFieldsConfig {
  kanbanStatusField: string | null
  calendarDateField: string | null
}

export const EMPTY_VIEW_FIELDS: ViewFieldsConfig = {
  kanbanStatusField: null,
  calendarDateField: null,
}

/** The list view's display-mode switcher (top-right of the list). */
export type DisplayMode = 'list' | 'kanban' | 'calendar' | 'graph'

export const DISPLAY_MODES: readonly DisplayMode[] = ['list', 'kanban', 'calendar', 'graph']

/**
 * Which modes are usable right now for a given entity's field config. `list`
 * and `graph` need no configuration (graph starts as an empty canvas);
 * `kanban`/`calendar` stay disabled until an admin sets the matching field
 * from Settings -> Views.
 */
export function availableDisplayModes(config: ViewFieldsConfig): Record<DisplayMode, boolean> {
  return {
    list: true,
    kanban: config.kanbanStatusField != null,
    calendar: config.calendarDateField != null,
    graph: true,
  }
}
