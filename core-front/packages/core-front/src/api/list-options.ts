// Client-safe list-refinement types. The server ApiClient consumes them to build
// the generic Go list endpoint's query string; relation widgets (client) pass
// them through the RelationOps Server Actions — so the contract must live
// outside the 'server-only' ApiClient module.

/**
 * Server-side list refinements, mapping 1:1 to the generic Go list endpoint:
 * `filter` = exact column match (relation scoping — o2m inverse lists, junction
 * reads); `search` = case-insensitive containment (autocomplete). Columns must
 * exist on the table — Go answers 400 for unknown ones.
 */
export interface EntityListOptions {
  filter?: Record<string, string>
  search?: Record<string, string>
  page?: number
  pageSize?: number
}
