import { validateDescriptorWidgets, type ViewDescriptor } from '../views/descriptor'

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

/**
 * Build-time metadata attached when a module is registered — sourced from the module's
 * `module.json`, not from the FrontModule itself (the views file stays descriptors-only;
 * how the module presents in the shell is deployment metadata, so it lives in the same
 * manifest the Go backend reads).
 */
export interface RegisterOptions {
  /**
   * `module.json` `app_mode`: the module is a full application and gets a tile on the
   * landing menu. Default false — its routes stay registered and navigable (deep links,
   * cross-module formPath targets), it just has no home-page entry.
   */
  appMode?: boolean
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

/** A directly navigable view in the application menu (a concrete path, no `:param`). */
export interface MenuRoute {
  path: string
  descriptor: ViewDescriptor
  permission?: string
}

/** An installed application and its navigable views, for the landing menu. */
export interface MenuModule {
  name: string
  routes: MenuRoute[]
}

/**
 * The canonical top-level pages a module may expose, in display order. The module
 * nav (next to the breadcrumb) shows each page the module actually has — a module is
 * never required to provide all three. Identified by a route's last path segment, so a
 * module opts in simply by declaring a `/<module>/dashboard|list|settings` route.
 */
export type MainPageKind = 'dashboard' | 'list' | 'settings'

const MAIN_PAGE_ORDER: MainPageKind[] = ['dashboard', 'list', 'settings']
const MAIN_PAGE_LABELS: Record<MainPageKind, string> = {
  dashboard: 'Dashboard',
  list: 'List',
  settings: 'Settings',
}

/** One entry in a module's top-bar navigation. */
export interface MainPage {
  kind: MainPageKind
  /** Human label shown in the nav (e.g. 'Dashboard'). */
  label: string
  /** Concrete path the entry links to. */
  path: string
  permission?: string
}

/** A module paired with the main pages it exposes, for the top-bar module nav. */
export interface ModuleNav {
  module: string
  pages: MainPage[]
}

/** Classify a route's last path segment as a main-page kind, or null if it isn't one. */
function mainPageKind(path: string): MainPageKind | null {
  const last = splitPath(path).pop()
  return MAIN_PAGE_ORDER.includes(last as MainPageKind) ? (last as MainPageKind) : null
}

interface RegisteredModule {
  module: FrontModule
  appMode: boolean
}

export class ModuleRegistry {
  private readonly entries: RegisteredModule[] = []

  register(module: FrontModule, options: RegisterOptions = {}): this {
    // Fail loud at registration (build/boot), not at render: a descriptor with a
    // widget its field type forbids is a module bug, named module + route + field.
    for (const route of module.routes) {
      try {
        validateDescriptorWidgets(route.descriptor)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        throw new Error(`module "${module.name}", route "${route.path}": ${message}`)
      }
    }
    this.entries.push({ module, appMode: options.appMode === true })
    return this
  }

  /**
   * Flatten registered modules to a path -> RouteConfig map, preserving registration
   * and route declaration order. A later route with the same path wins (last wins).
   */
  buildRegistry(): Map<string, RouteConfig> {
    const map = new Map<string, RouteConfig>()
    for (const { module } of this.entries) {
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
   * The installed-application menu: every module registered as an application
   * (`module.json` `app_mode: true`) paired with its directly navigable routes — those
   * with no `:param` segment. A form route like '/crm/contacts/:id' needs an id, so it
   * is not a menu entry; the list/tree view that links to it is. Preserves registration
   * order; non-app modules and modules left with no navigable route are omitted (their
   * routes stay reachable — they just get no tile). The landing page renders this
   * (permission-filtered) as the menu.
   */
  menu(): MenuModule[] {
    const result: MenuModule[] = []
    for (const { module, appMode } of this.entries) {
      if (!appMode) continue
      const routes = module.routes.filter((route) => !hasParam(route.path))
      if (routes.length > 0) result.push({ name: module.name, routes })
    }
    return result
  }

  /**
   * The top-bar module navigation: every registered module paired with the main pages
   * it exposes (dashboard / list / settings), in canonical order. A module appears only
   * with the pages it actually declares — "if it has it" — and modules with none are
   * omitted. The shell renders the entry for the module the current route belongs to,
   * next to the breadcrumb. The first declared route of each kind wins.
   */
  moduleNav(): ModuleNav[] {
    const result: ModuleNav[] = []
    for (const { module } of this.entries) {
      const byKind = new Map<MainPageKind, MainPage>()
      for (const route of module.routes) {
        const kind = mainPageKind(route.path)
        if (kind && !byKind.has(kind)) {
          byKind.set(kind, {
            kind,
            label: MAIN_PAGE_LABELS[kind],
            path: route.path,
            permission: route.permission,
          })
        }
      }
      const pages = MAIN_PAGE_ORDER.filter((k) => byKind.has(k)).map((k) => byKind.get(k)!)
      if (pages.length > 0) result.push({ module: module.name, pages })
    }
    return result
  }

  /**
   * A module's flat/hierarchical list views (viewType 'tree'). The dashboard rolls these
   * up into one block each (name + entry count), so it needs to know which list views the
   * owning module ships. Empty for an unknown module.
   */
  listViews(moduleName: string): MenuRoute[] {
    const module = this.entries.find((e) => e.module.name === moduleName)?.module
    if (!module) return []
    return module.routes
      .filter((route) => route.descriptor.viewType === 'tree')
      .map((route) => ({ path: route.path, descriptor: route.descriptor, permission: route.permission }))
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

function hasParam(path: string): boolean {
  return splitPath(path).some((segment) => segment.startsWith(':'))
}

/**
 * Shared registry the generated discovery manifest registers modules with and the
 * catch-all route reads. One instance per running app.
 */
export const moduleRegistry = new ModuleRegistry()
