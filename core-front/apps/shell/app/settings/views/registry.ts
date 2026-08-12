import { moduleRegistry } from '@eerp/core-front/server'
import type { FieldDescriptor, ViewModeDefaults } from '@eerp/core-front'

// Every entity with a registered tree (list) view, paired with the fields an
// admin may pick as its Kanban status field (type 'selection') or Calendar
// date field (type 'date') — sourced from the already-registered descriptors
// (no new backend introspection route needed; docs/roadmaps/list-view-modes.md).

export interface ViewEntityFields {
  entity: string
  /** The module that registered this entity's tree view — the caller filters
   * on this against the live active state (module-state.ts); discovery no
   * longer skips `active: false` modules (ADR-009), so this registry alone
   * can no longer tell an active entity from a deactivated one. */
  module: string
  kanbanFields: FieldDescriptor[]
  dateFields: FieldDescriptor[]
  /** The module's own hardcoded Kanban/Calendar/Graph baseline, if it
   * declared one (docs/adr/ADR-006-runtime-configurable-view-fields.md's
   * amendment) — {} when it declared none. */
  defaults: ViewModeDefaults
}

export function treeViewEntities(): ViewEntityFields[] {
  const seen = new Map<string, ViewEntityFields>()
  for (const { module, descriptor } of moduleRegistry.buildRegistry().values()) {
    if (descriptor.viewType !== 'tree') continue
    // Two paths (e.g. a hierarchical view and a flat fallback) can point at
    // the same entity; the field config is per-entity, so the first wins.
    if (seen.has(descriptor.entity)) continue
    seen.set(descriptor.entity, {
      entity: descriptor.entity,
      module,
      kanbanFields: descriptor.fields.filter((f) => f.type === 'selection'),
      dateFields: descriptor.fields.filter((f) => f.type === 'date'),
      defaults: descriptor.viewModeDefaults ?? {},
    })
  }
  return Array.from(seen.values())
}
