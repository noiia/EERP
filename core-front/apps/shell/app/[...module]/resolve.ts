import { moduleRegistry, type RouteConfig } from '@eerp/core-front/server'

// Maps a catch-all path back to its registered route. Modules register into the
// shared registry when the generated manifest is imported (by the page); this reads
// the flattened path -> RouteConfig map.

export function modulePathFromSegments(segments: string[]): string {
  return '/' + segments.join('/')
}

export function resolveModuleRoute(segments: string[]): RouteConfig | undefined {
  return moduleRegistry.buildRegistry().get(modulePathFromSegments(segments))
}
