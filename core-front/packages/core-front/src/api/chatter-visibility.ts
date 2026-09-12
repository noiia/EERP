// Form chatter panel visibility (core-front/CLAUDE.md's "Form chatter panel"
// row): whether a `viewType: 'form'` route renders its per-record activity
// feed at all. A module MAY declare a hardcoded BASELINE
// (`ViewDescriptor.showChatter`, descriptor.ts — omitted means "on", true by
// design) and an admin MAY additionally override it per entity from Settings
// -> Apps -> :module (the same "Views" section the Kanban/Calendar/Graph
// config lives in) — effectiveChatterVisible merges the two, override
// winning when set. Same shape as api/view-fields.ts, kept as its own tiny
// module since chatter is a form concern, unrelated to that file's tree-view
// display modes.

/** Server state: app_settings key `views.<entity>.chatter`, mirrored
 * camelCase client-side. `null` means "no workspace override" — NOT
 * "hidden"; effectiveChatterVisible falls back to the entity's own
 * ViewDescriptor.showChatter (a module's hardcoded baseline) before landing
 * on the true-by-design default. */
export interface ChatterVisibilityConfig {
  enabled: boolean | null
}

export const EMPTY_CHATTER_VISIBILITY: ChatterVisibilityConfig = { enabled: null }

/**
 * Merges an admin's stored override (`ChatterVisibilityConfig`, null =
 * "not overridden") over a module's own hardcoded `ViewDescriptor.showChatter`
 * baseline. The module's value is the fallback; a non-null override always
 * wins over it; true is the final fallback when neither is set.
 */
export function effectiveChatterVisible(
  moduleDefault: boolean | undefined,
  config: ChatterVisibilityConfig,
): boolean {
  return config.enabled ?? moduleDefault ?? true
}
