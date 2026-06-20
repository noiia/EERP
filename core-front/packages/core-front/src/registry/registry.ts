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
}

/**
 * Shared registry the generated discovery manifest registers modules with and the
 * catch-all route reads. One instance per running app.
 */
export const moduleRegistry = new ModuleRegistry()
