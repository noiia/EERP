import { moduleRegistry, type RouteMatch } from '@eerp/core-front/server'

// Maps a catch-all path back to its registered route, extracting any `:param` values
// (e.g. the form route '/crm/contacts/:id'). Modules register into the shared registry
// when the generated manifest is imported (by the page).

export function modulePathFromSegments(segments: string[]): string {
  return '/' + segments.join('/')
}

export function resolveModuleRoute(segments: string[]): RouteMatch | null {
  return moduleRegistry.match(modulePathFromSegments(segments))
}

/** "crm" -> "Crm", "contacts" -> "Contacts" — a readable label from a slug. */
function titleize(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * A human page-title for a module route: the last meaningful path segment, titleized.
 * `:param` (id) segments are dropped so a form route like '/crm/contacts/42' titles as
 * "Contacts", not "42".
 */
export function modulePageTitle(segments: string[], params: Record<string, string>): string {
  const paramValues = new Set(Object.values(params))
  const meaningful = segments.filter((segment) => !paramValues.has(segment))
  const last = meaningful[meaningful.length - 1] ?? segments[segments.length - 1] ?? ''
  return titleize(last)
}
