// Client-safe list-refinement types. The server ApiClient consumes them to build
// the generic Go list endpoint's query string; relation widgets (client) pass
// them through the RelationOps Server Actions — so the contract must live
// outside the 'server-only' ApiClient module.

/**
 * Server-side list refinements, mapping 1:1 to the generic Go list endpoint:
 * `filter` = exact column match (relation scoping — o2m inverse lists, junction
 * reads); `search` = case-insensitive containment (autocomplete); `in` = one
 * of several values (the search bar's multi-select filter); `gt`/`gte`/`lt`/
 * `lte` = range comparisons (the search bar's number/date range filters,
 * docs/adr/ADR-014-search-filter-bar.md — a "between" is just a gte AND an
 * lte on the same column). Columns must exist on the table AND, when gated,
 * the caller's groups must intersect them — Go answers 400 either way,
 * indistinguishable from an unknown column on purpose.
 */
export interface EntityListOptions {
  filter?: Record<string, string>
  search?: Record<string, string>
  in?: Record<string, string[]>
  gt?: Record<string, string>
  gte?: Record<string, string>
  lt?: Record<string, string>
  lte?: Record<string, string>
  page?: number
  pageSize?: number
}
