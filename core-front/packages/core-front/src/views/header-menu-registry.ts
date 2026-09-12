// The top-bar header-menu registry — module-scoped, unlike menu-actions.ts's
// entity-scoped MenuActionRegistry, since a header menu (Odoo-style "Orders /
// To Invoice / Products / Reporting / Configuration") belongs to the APP, not
// to one record's form. A module calls registerHeaderMenu() at import time
// (same "views file populates a client registry at import time" shape
// registerMenuAction/registerFieldFunction already use) to add lines — or a
// whole new named menu — to its own top bar; ModuleRegistry.headerMenus()
// (registry/registry.ts) reads this registry to assemble the final per-module
// menu list, merging in the auto-generated list/catalog/dashboard menus and
// the always-present Configuration menu around whatever's registered here.

/** One navigable line in a header menu's dropdown. */
export interface HeaderMenuLine {
  kind: 'line'
  label: string
  path: string
  permission?: string
}

/** A labeled cluster of lines inside a header menu's dropdown — one level of
 * nesting only, no groups-within-groups ("simple lines and sub-groups with
 * lines inside"). */
export interface HeaderMenuGroup {
  kind: 'group'
  label: string
  children: HeaderMenuLine[]
}

export type HeaderMenuNode = HeaderMenuLine | HeaderMenuGroup

/** One top-bar menu button (e.g. "Products", "Configuration") plus its
 * dropdown content. */
export interface HeaderMenu {
  /** Stable id within the module — a route path for an auto-generated menu,
   * or the name a registerHeaderMenu() call chose (e.g. "configuration"). */
  name: string
  /** Button/title text. */
  label: string
  entries: HeaderMenuNode[]
}

export interface RegisterHeaderMenuOptions {
  /** Button/title text — only meaningful the FIRST time this (module, name)
   * pair is registered; later calls appending to the same menu keep the
   * original label unless they pass their own. */
  label?: string
  entries: HeaderMenuNode[]
}

/**
 * Validates a header menu's entries: non-empty label/path on every line,
 * non-empty label and at least one child on every group, group children are
 * lines only (never nested groups), and no two SIBLING lines share a label
 * (two sibling GROUPS sharing a label is the deliberate merge signal, never
 * an error — see mergeEntries below). Thrown with module/name context by the
 * caller, mirroring validateMenuActions' fail-loud-at-registration posture.
 */
function validateHeaderMenuEntries(entries: HeaderMenuNode[]): void {
  const lineLabels = new Set<string>()
  for (const node of entries) {
    if (node.kind === 'line') {
      if (!node.label) throw new Error('a header menu line needs a non-empty label')
      if (!node.path) throw new Error(`header menu line "${node.label}" needs a non-empty path`)
      if (lineLabels.has(node.label)) {
        throw new Error(`duplicate header menu line label "${node.label}"`)
      }
      lineLabels.add(node.label)
      continue
    }
    if (!node.label) throw new Error('a header menu group needs a non-empty label')
    if (node.children.length === 0) {
      throw new Error(`header menu group "${node.label}" needs at least one line`)
    }
    const childLabels = new Set<string>()
    for (const child of node.children) {
      if (child.kind !== 'line') {
        throw new Error(
          `header menu group "${node.label}" may only contain lines, not nested groups`,
        )
      }
      if (!child.label)
        throw new Error(`a line in header menu group "${node.label}" needs a non-empty label`)
      if (!child.path) throw new Error(`header menu line "${child.label}" needs a non-empty path`)
      if (childLabels.has(child.label)) {
        throw new Error(
          `duplicate line label "${child.label}" in header menu group "${node.label}"`,
        )
      }
      childLabels.add(child.label)
    }
  }
}

/**
 * Appends `incoming` onto `existing` in place: a `line` is pushed as a new
 * top-level entry; a `group` merges into an existing top-level group of the
 * SAME label (pushing onto its children) rather than duplicating it — the
 * "sub-groups creatable by users in order to add lines inside" mechanism:
 * register the group once, register more lines into it later (from the same
 * or a different module views file).
 */
function mergeEntries(existing: HeaderMenuNode[], incoming: HeaderMenuNode[]): HeaderMenuNode[] {
  const result = [...existing]
  for (const node of incoming) {
    if (node.kind === 'line') {
      result.push(node)
      continue
    }
    const target = result.find(
      (n): n is HeaderMenuGroup => n.kind === 'group' && n.label === node.label,
    )
    if (target) {
      target.children = [...target.children, ...node.children]
    } else {
      result.push({ ...node, children: [...node.children] })
    }
  }
  return result
}

class HeaderMenuRegistry {
  private readonly menus = new Map<string, HeaderMenu>()

  /** Create-or-append a header menu under (module, name) — see registerHeaderMenu. */
  register(module: string, name: string, opts: RegisterHeaderMenuOptions): void {
    const key = `${module}:${name}`
    const existing = this.menus.get(key)
    const merged: HeaderMenu = {
      name,
      label: opts.label ?? existing?.label ?? name,
      entries: mergeEntries(existing?.entries ?? [], opts.entries),
    }
    try {
      validateHeaderMenuEntries(merged.entries)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      throw new Error(`header menu "${module}:${name}": ${message}`, { cause: e })
    }
    this.menus.set(key, merged)
  }

  /** Every header menu registered for `module`, in registration order. */
  forModule(module: string): HeaderMenu[] {
    const prefix = `${module}:`
    return [...this.menus.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, menu]) => menu)
  }

  /** Test-only: forget everything. */
  clear(): void {
    this.menus.clear()
  }
}

/** The shared registry module views files populate at import time. */
export const headerMenuRegistry = new HeaderMenuRegistry()

/**
 * Add lines (or a whole new named menu) to a module's top bar — create-or-
 * append under (module, name): a second call under the same name appends its
 * entries onto whatever's already there, merging into a same-labeled group
 * rather than duplicating it. `name: 'configuration'` is the reserved
 * convention every module's own Configuration dropdown lives under (see
 * ModuleRegistry.headerMenus(), which seeds it with a default "Settings"
 * line before merging in whatever's registered here) — a module doesn't
 * need to create that menu itself, just register more entries into it.
 * Import-time, client-safe.
 */
export function registerHeaderMenu(
  module: string,
  name: string,
  opts: RegisterHeaderMenuOptions,
): void {
  headerMenuRegistry.register(module, name, opts)
}
