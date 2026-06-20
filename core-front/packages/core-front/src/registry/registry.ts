import type { ViewDescriptor } from '../views/descriptor'

// The frontend module contract + registry. A module contributes DESCRIPTORS ONLY:
// it default-exports a FrontModule listing routes, each a path + descriptor (+ optional
// permission). The engine derives the server loader, the Zustand store, and the
// renderer from the descriptor — modules never ship loaders/stores/renderers
// (CONVENTIONS.md — Module FE contract). The build-time discovery (Phase 2) registers
// every module's default export, then the catch-all route consumes buildRegistry().

export interface FrontRoute {
  /** App Router pathname this route serves, e.g. '/crm/contacts'. */
  path: string
  descriptor: ViewDescriptor
  /** Permission required to view; the server guard enforces it. */
  permission?: string
}

export interface FrontModule {
  name: string
  routes: FrontRoute[]
}

/** What the catch-all page resolves per path: the owning module + how to render it. */
export interface RouteConfig {
  module: string
  descriptor: ViewDescriptor
  permission?: string
}

/** A resolved route plus the `:param` values extracted from the concrete pathname. */
export interface RouteMatch {
  route: RouteConfig
  params: Record<string, string>
}

export class ModuleRegistry {
  private readonly modules: FrontModule[] = []

  register(module: FrontModule): this {
    this.modules.push(module)
    return this
  }

  /**
   * Flatten registered modules to a path -> RouteConfig map, preserving registration
   * and route declaration order. A later route with the same path wins (last wins).
   */
  buildRegistry(): Map<string, RouteConfig> {
    const map = new Map<string, RouteConfig>()
    for (const module of this.modules) {
      for (const route of module.routes) {
        map.set(route.path, {
          module: module.name,
          descriptor: route.descriptor,
          permission: route.permission,
        })
      }
    }
    return map
  }

  /**
   * Match a concrete pathname to a registered route, extracting `:param` segments.
   * Exact paths win over patterns; otherwise the first pattern (in registration order)
   * with the same segment count whose literals match is returned. So '/crm/contacts'
   * resolves to the list route and '/crm/contacts/42' to the form route ({ id: '42' }).
   */
  match(pathname: string): RouteMatch | null {
    const map = this.buildRegistry()
    const exact = map.get(pathname)
    if (exact) return { route: exact, params: {} }

    const segments = splitPath(pathname)
    for (const [pattern, route] of map) {
      const patternSegments = splitPath(pattern)
      if (patternSegments.length !== segments.length) continue

      const params: Record<string, string> = {}
      let matched = true
      for (let i = 0; i < patternSegments.length; i++) {
        const part = patternSegments[i]
        if (part.startsWith(':')) params[part.slice(1)] = segments[i]
        else if (part !== segments[i]) {
          matched = false
          break
        }
      }
      if (matched) return { route, params }
    }
    return null
  }
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean)
}

/**
 * Shared registry the generated discovery manifest registers modules with and the
 * catch-all route reads. One instance per running app.
 */
export const moduleRegistry = new ModuleRegistry()
