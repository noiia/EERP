import type { MenuNode, ViewDescriptor } from './descriptor'

// The form actions menu's behavior layer (docs/adr/ADR-011), mirroring
// behaviors.ts's compute/on_change registry exactly: a MenuActionNode names
// its handler by NAME (`action: 'sale.printInvoice'`) because descriptors
// cross the RSC boundary as props and a function reference cannot survive
// that trip — the code lives here, in a client registry the module's views
// file populates at import time:
//
//   registerMenuAction({ entity: 'invoice', name: 'sale.printInvoice',
//     handler: ({ recordId }) => exportReportPDF('sale.invoice', recordId) })

/** What a menu action handler receives — just enough to act on THIS record. */
export interface MenuActionContext {
  entity: string
  recordId: string
}

export interface MenuActionHandler {
  /** Entity the action belongs to — must match the descriptor's entity. */
  entity: string
  /** Globally unique name a MenuActionNode's `action` references. */
  name: string
  handler: (ctx: MenuActionContext) => void | Promise<void>
}

class MenuActionRegistry {
  private readonly actions = new Map<string, MenuActionHandler>()

  register(action: MenuActionHandler): void {
    if (this.actions.has(action.name)) {
      throw new Error(`menu action "${action.name}" is already registered`)
    }
    this.actions.set(action.name, action)
  }

  get(name: string): MenuActionHandler | undefined {
    return this.actions.get(name)
  }

  /** Test-only: forget everything (mirrors behaviorRegistry.clear()). */
  clear(): void {
    this.actions.clear()
  }
}

/** The shared registry module views files populate at import time. */
export const menuActionRegistry = new MenuActionRegistry()

/** Register a menu action handler (see MenuActionHandler). Import-time, client-safe. */
export function registerMenuAction(action: MenuActionHandler): void {
  menuActionRegistry.register(action)
}

/**
 * Validate a descriptor's `actions` tree at registration: every leaf's
 * `action` name must be registered for THIS descriptor's entity — the same
 * "fail at registration, not at render/click" discipline `buildBehaviorPlan`
 * already applies to `compute`/`on_change`. A no-op when `actions` is omitted.
 */
export function validateMenuActions(descriptor: ViewDescriptor): void {
  const visit = (node: MenuNode): void => {
    if (node.kind === 'submenu') {
      for (const child of node.children) visit(child)
      return
    }
    const action = menuActionRegistry.get(node.action)
    if (!action) {
      throw new Error(`menu action "${node.action}" is not registered`)
    }
    if (action.entity !== descriptor.entity) {
      throw new Error(
        `menu action "${node.action}" belongs to entity "${action.entity}", not "${descriptor.entity}"`,
      )
    }
  }
  for (const node of descriptor.actions ?? []) visit(node)
}
