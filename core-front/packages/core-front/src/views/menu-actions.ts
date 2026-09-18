import type { MenuNode, ViewDescriptor } from './descriptor'
import type { RelationOps } from './relation-ops'

// The form actions menu's behavior layer (docs/adr/ADR-011), mirroring
// behaviors.ts's compute/on_change registry exactly: a MenuActionNode names
// its handler by NAME (`action: 'sale.printInvoice'`) because descriptors
// cross the RSC boundary as props and a function reference cannot survive
// that trip — the code lives here, in a client registry the module's views
// file populates at import time:
//
//   registerMenuAction({ entity: 'invoice', name: 'sale.printInvoice',
//     handler: ({ recordId }) => exportReportPDF('sale.invoice', recordId) })

/**
 * What a menu action handler receives — as of `draft`/`setFieldAndCommit`/
 * `relationOps` below, the SAME shape as HeaderButtonContext
 * (header-button-actions.ts) when run from FormActionsMenu, so a workflow
 * action can move between the always-visible header-button row and this
 * menu with NO change to its own handler body (propertymanagement's
 * "Generate Rent Receipt" is the first mover — reads the current draft,
 * calls into RelationOps to create the receipt rows, then setFieldAndCommit
 * to stamp last_receipt_month back onto the property). The three extra
 * fields are optional because the SAME context shape also backs
 * list-selection.tsx's bulk actions menu, which has no single draft/commit
 * target to offer — a simple, recordId-only action like sale.printInvoice
 * still works unchanged either way.
 */
export interface MenuActionContext {
  entity: string
  recordId: string
  /**
   * The record's current field values, as displayed (the live draft — may
   * include unsaved edits, same as any other in-progress form state).
   * Present when run from FormActionsMenu (a single, real record); absent
   * from list-selection.tsx's bulk actions menu, which has no single draft
   * to offer (it runs the SAME handler once per selected id instead) — an
   * action reading this must be a form-only action, never also wired onto a
   * tree descriptor's own `actions`.
   */
  draft?: Record<string, unknown>
  /**
   * Patch one or more fields on THIS record and persist them through the
   * SAME commit path Save uses (server action -> Go -> reconcile) — the
   * menu-action equivalent of the user editing a field and clicking Save.
   * Resolves to the saved record, or null if the commit was blocked/failed.
   * Same form-only availability as `draft` above.
   */
  setFieldAndCommit?: (patch: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  /** Entity-generic reads/creates for OTHER entities (RelationOps — the SAME
   * ops the relation widgets use) — null when the host hasn't mounted a
   * RelationOpsProvider, the same inert posture every Ops context takes.
   * Available from BOTH FormActionsMenu and the bulk actions menu. */
  relationOps?: RelationOps | null
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
