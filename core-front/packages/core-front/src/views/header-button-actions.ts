import type { ViewDescriptor } from './descriptor'
import type { RelationOps } from './relation-ops'

// The header-button-container's behavior layer, mirroring menu-actions.ts's
// MenuActionRegistry exactly — a HeaderButtonDescriptor names its handler by
// NAME (descriptors cross the RSC boundary as props, so a function reference
// cannot survive that trip). The context a handler receives is richer than a
// menu action's (just entity+recordId): a header button typically needs to
// mutate the record it's ON (a workflow status transition) and/or read/create
// OTHER entities' records (e.g. "Accept" creating an invoice from a quote) —
// see setFieldAndCommit/relationOps below.

/** What a header button handler receives. */
export interface HeaderButtonContext {
  entity: string
  recordId: string
  /** The record's current field values, as displayed (the live draft — may
   * include unsaved edits, same as any other in-progress form state). */
  draft: Record<string, unknown>
  /**
   * Patch one or more fields on THIS record and persist them through the
   * SAME commit path Save uses (server action -> Go -> reconcile) — the
   * header-button equivalent of the user editing a field and clicking Save.
   * Resolves to the saved record, or null if the commit was blocked/failed
   * (a required-field guard, a rejected write) — same "null means it didn't
   * happen" contract FormState.commit() already has.
   */
  setFieldAndCommit: (patch: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  /**
   * Entity-generic reads/creates for OTHER entities (RelationOps — the SAME
   * ops the relation widgets use) — null when the host hasn't mounted a
   * RelationOpsProvider, the same inert posture every Ops context takes.
   */
  relationOps: RelationOps | null
}

export interface HeaderButtonHandler {
  /** Entity the button belongs to — must match the descriptor's entity. */
  entity: string
  /** Globally unique name a HeaderButtonDescriptor's `name` references. */
  name: string
  handler: (ctx: HeaderButtonContext) => void | Promise<void>
}

class HeaderButtonRegistry {
  private readonly buttons = new Map<string, HeaderButtonHandler>()

  register(button: HeaderButtonHandler): void {
    if (this.buttons.has(button.name)) {
      throw new Error(`header button "${button.name}" is already registered`)
    }
    this.buttons.set(button.name, button)
  }

  get(name: string): HeaderButtonHandler | undefined {
    return this.buttons.get(name)
  }

  /** Test-only: forget everything (mirrors menuActionRegistry.clear()). */
  clear(): void {
    this.buttons.clear()
  }
}

/** The shared registry module views files populate at import time. */
export const headerButtonRegistry = new HeaderButtonRegistry()

/** Register a header button handler (see HeaderButtonHandler). Import-time, client-safe. */
export function registerHeaderButtonAction(button: HeaderButtonHandler): void {
  headerButtonRegistry.register(button)
}

/**
 * Validate a descriptor's `headerButtons` at registration: every entry's
 * `name` must be registered for THIS descriptor's entity — the same "fail at
 * registration, not at render/click" discipline validateMenuActions applies
 * to the options menu. A no-op when `headerButtons` is omitted.
 */
export function validateHeaderButtons(descriptor: ViewDescriptor): void {
  for (const button of descriptor.headerButtons ?? []) {
    const registered = headerButtonRegistry.get(button.name)
    if (!registered) {
      throw new Error(`header button "${button.name}" is not registered`)
    }
    if (registered.entity !== descriptor.entity) {
      throw new Error(
        `header button "${button.name}" belongs to entity "${registered.entity}", not "${descriptor.entity}"`,
      )
    }
  }
}
