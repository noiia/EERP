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
