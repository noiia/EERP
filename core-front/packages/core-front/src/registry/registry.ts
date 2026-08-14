import { buildBehaviorPlan } from '../views/behaviors'
import {
  normalizeLayout,
  validateCatalogDescriptor,
  validateDescriptorWidgets,
  validateSearchDescriptor,
  validateStatusBarDescriptor,
  type ViewDescriptor,
} from '../views/descriptor'
import { validateMenuActions } from '../views/menu-actions'
import { validateReportDescriptor, type ReportDescriptor } from '../views/report-descriptor'
import { applyExtension, type ViewExtension } from './extensions'

// The frontend module contract + registry. A module contributes DESCRIPTORS ONLY:
// it default-exports a FrontModule listing routes, each a path + descriptor (+ optional
// permission), and optionally `extends` — view EXTENSIONS reshaping ANOTHER module's
// (or its own) already-registered routes (docs/roadmaps/view-customization.md, Phase 3).
// The engine derives the server loader, the Zustand store, and the renderer from the
// RESOLVED descriptor — modules never ship loaders/stores/renderers (CONVENTIONS.md —
// Module FE contract). The build-time discovery registers every module's default
// export in `depends` topological order, then the catch-all route consumes
// buildRegistry().

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
  /** View extensions this module contributes over already-registered routes
   * (its own or another module's) — see ViewExtension (extensions.ts). */
  extends?: ViewExtension[]
  /** PDF reports this module contributes (docs/roadmaps/pdf-reports.md) —
   * resolved by NAME (not path) via buildReportRegistry(), unlike routes. */
  reports?: ReportDescriptor[]
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
  /**
   * `module.json` `depends`: the OTHER modules this one declares a relationship to
   * (the same field the Go loader reads). Discovery registers modules in `depends`
   * topological order, so a module's extensions always find their target already
   * registered. Also the input to the depends-coverage warning: `register()` warns
   * (does not throw — this is a hygiene check, not a correctness gate) when a
   * module's `extends` targets a path owned by a module absent from this list.
   */
  depends?: string[]
  /**
   * `module.json` `menu_icon`: a Font Awesome solid icon name (`byPrefixAndName.fas`
   * key, e.g. `'warehouse'`) for this module's landing-menu tile. Separate from
   * module.json's own `icon` field (the App Store catalog's plain-text/emoji avatar
   * for the module's own row — a multi-char FA name would render badly there).
   * Omitted ⇒ the tile falls back to its monogram letter.
   */
  icon?: string
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
  /** Font Awesome solid icon name for the tile (RegisterOptions.icon), or undefined
   * to fall back to the tile's monogram letter. */
  icon?: string
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
  icon?: string
}

/** Validate a descriptor at registration: widget/type pairs, the behavior plan
 * (compute/on_change/defaults), and layout tree consistency (every field-leaf
 * exists, no duplicates, unique ids) — the full "fail loud, not at render"
 * contract, run identically for a base route and an extension's merged result. */
function validateDescriptor(descriptor: ViewDescriptor): void {
  validateDescriptorWidgets(descriptor)
  validateCatalogDescriptor(descriptor)
  validateSearchDescriptor(descriptor)
  validateStatusBarDescriptor(descriptor)
  validateMenuActions(descriptor)
  buildBehaviorPlan(descriptor)
  normalizeLayout(descriptor)
}

export class ModuleRegistry {
  private readonly entries: RegisteredModule[] = []
  // The descriptor-content source of truth: base routes populate it on
  // registration, then each module's `extends` REPLACES its target path's
  // entry with the merged result — "ModuleRegistry applies all extensions for
  // a path at registration" (the contracts table), so this map already IS the
  // memo; buildRegistry()/menu()/etc. just read it. `entries` stays the
  // source of truth for module identity/order (menu grouping, moduleNav) —
  // the two structures serve different questions ("what did module X ship"
  // vs. "what does path P resolve to right now").
  private readonly resolvedRoutes = new Map<string, RouteConfig>()
  // Report name -> descriptor, populated alongside resolvedRoutes at
  // registration. Reports resolve by NAME, not path — a report has no
  // App Router route of its own to match against, only the print route's
  // :name param — so this is a separate map, not folded into resolvedRoutes.
  private readonly resolvedReports = new Map<string, ReportDescriptor>()

  register(module: FrontModule, options: RegisterOptions = {}): this {
    // Idempotent by module name: the server manifest and the client manifest
    // (ModulesInit) both evaluate during SSR, where the two barrels resolve to
    // this same registry instance — the second registration of a name is the
    // same manifest running again, not a new module, so it is skipped.
    if (this.entries.some((e) => e.module.name === module.name)) return this

    // Fail loud at registration (build/boot), not at render: a widget the field
    // type forbids, an unregistered compute name, a compute cycle, or a broken
    // layout anchor is a module bug, named module + route + field. Views files
    // register their field functions at import time, so they exist by the time
    // the generated manifest registers the module.
    for (const route of module.routes) {
      try {
        validateDescriptor(route.descriptor)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        throw new Error(`module "${module.name}", route "${route.path}": ${message}`, { cause: e })
      }
      // Base registration (or a deliberate REPLACE of an existing path — "last
      // wins", the blunt escape hatch `extends` exists to make unnecessary).
      // A replace on a path an earlier module extended drops those extensions:
      // a full descriptor swap is a new view, not a merge.
      this.resolvedRoutes.set(route.path, {
        module: module.name,
        descriptor: route.descriptor,
        permission: route.permission,
      })
    }

    // Reports validate and register independently of routes/extends — they
    // have no path to match, no layout-tree merge, no extension mechanism
    // (v1 scope, docs/roadmaps/pdf-reports.md Phase 2).
    for (const report of module.reports ?? []) {
      try {
        validateReportDescriptor(report)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        throw new Error(`module "${module.name}", report "${report.name}": ${message}`, { cause: e })
      }
      this.resolvedReports.set(report.name, report)
    }

    this.entries.push({ module, appMode: options.appMode === true, icon: options.icon })

    // Extensions apply AFTER this module's own routes are registered, on top
    // of whatever the target path currently resolves to (the base, or the
    // result of earlier modules' extensions) — "extensions apply after the
    // base and after earlier modules' extensions" (the contracts table).
    // "Already-registered routes" means the target must exist NOW: a base
    // module always registers before its extenders under `depends`
    // topological discovery order, so this is a build-time invariant, not a
    // runtime race.
    for (const ext of module.extends ?? []) {
      const current = this.resolvedRoutes.get(ext.path)
      if (!current) {
        throw new Error(`module "${module.name}" extends unknown path "${ext.path}"`)
      }
      // Hygiene warning, not a hard error: extending a path you don't declare
      // a dependency on works (registration order already guarantees the
      // target exists), but silently coupling to another module's view
      // without recording that relationship in module.json is exactly the
      // "alphabetical order is a landmine" pitfall in a new shape.
      if (current.module !== module.name && !(options.depends ?? []).includes(current.module)) {
        console.warn(
          `[view-extension] module "${module.name}" extends path "${ext.path}" ` +
            `(owned by module "${current.module}") without declaring "${current.module}" ` +
            `in its module.json "depends"`,
        )
      }
      let merged: ViewDescriptor
      try {
        merged = applyExtension(current.descriptor, ext.operations)
        validateDescriptor(merged)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        throw new Error(`module "${module.name}" extending "${ext.path}": ${message}`, { cause: e })
      }
      this.resolvedRoutes.set(ext.path, {
        module: current.module,
        descriptor: merged,
        permission: current.permission,
      })
    }

    return this
  }

  /**
   * The path -> RouteConfig map, already fully resolved (base + every
   * applicable extension) at registration time — this is a cheap accessor,
   * not a recomputation.
   */
  buildRegistry(): Map<string, RouteConfig> {
    return new Map(this.resolvedRoutes)
  }

  /**
   * The report name -> ReportDescriptor map, resolved at registration time —
   * the print route reads this the same way the catch-all reads
   * buildRegistry(), keyed by ReportDescriptor.name instead of a path.
   */
  buildReportRegistry(): Map<string, ReportDescriptor> {
    return new Map(this.resolvedReports)
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
    for (const { module, appMode, icon } of this.entries) {
      if (!appMode) continue
      const routes: MenuRoute[] = []
      for (const route of module.routes) {
        if (hasParam(route.path)) continue
        // Resolved descriptor — an extension may have reshaped this route
        // since the module declared it. Falls back to the declared one in
        // the (unreachable in practice) case a path was never resolved.
        const resolved = this.resolvedRoutes.get(route.path)
        routes.push({
          path: route.path,
          descriptor: resolved?.descriptor ?? route.descriptor,
          permission: resolved?.permission ?? route.permission,
        })
      }
      if (routes.length > 0) result.push({ name: module.name, routes, icon })
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
   * The first registered form-view descriptor over an entity, or null. The
   * relation widgets' create-from-search wizard renders this as the creation
   * form of the aimed table — the entity's own module already declared how the
   * record is edited (extensions included — a record created this way carries
   * whatever fields an extending module added), so creating it reuses the same
   * RESOLVED descriptor. Entities with no form view (e.g. a bare tag table)
   * get the caller's fallback instead.
   */
  formDescriptorFor(entity: string): ViewDescriptor | null {
    for (const { module } of this.entries) {
      for (const route of module.routes) {
        const resolved = this.resolvedRoutes.get(route.path)?.descriptor ?? route.descriptor
        if (resolved.viewType === 'form' && resolved.entity === entity) {
          return resolved
        }
      }
    }
    return null
  }

  /**
   * The first registered report over an entity, or null — same "first wins,
   * null if none" shape as formDescriptorFor. The catch-all's form route uses
   * this to decide whether to render an Export-to-PDF action: an entity with
   * no report gets none, same posture a tree view with no formPath gets no
   * Create button.
   */
  reportForEntity(entity: string): ReportDescriptor | null {
    for (const report of this.resolvedReports.values()) {
      if (report.entity === entity) return report
    }
    return null
  }

  /**
   * The paths a module's OWN `extends` targets — "which routes does this
   * module EDIT, as opposed to create" (docs/roadmaps/app-store.md, Phase 3's
   * Views notebook page: a route's `RouteConfig.module` stays the ORIGINAL
   * registrant through every extension merge, so `buildRegistry()` entries
   * alone already answer "created"; this is the other half). Empty for an
   * unknown module or one with no `extends`.
   */
  extendedPaths(moduleName: string): string[] {
    const module = this.entries.find((e) => e.module.name === moduleName)?.module
    return module?.extends?.map((ext) => ext.path) ?? []
  }

  /**
   * A module's flat/hierarchical list views (viewType 'tree'). The dashboard rolls these
   * up into one block each (name + entry count), so it needs to know which list views the
   * owning module ships. Empty for an unknown module.
   */
  listViews(moduleName: string): MenuRoute[] {
    const module = this.entries.find((e) => e.module.name === moduleName)?.module
    if (!module) return []
    const result: MenuRoute[] = []
    for (const route of module.routes) {
      const resolved = this.resolvedRoutes.get(route.path)
      const descriptor = resolved?.descriptor ?? route.descriptor
      if (descriptor.viewType !== 'tree') continue
      result.push({ path: route.path, descriptor, permission: resolved?.permission ?? route.permission })
    }
    return result
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
