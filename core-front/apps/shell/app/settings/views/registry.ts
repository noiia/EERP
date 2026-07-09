import { moduleRegistry } from '@eerp/core-front/server'
import type { FieldDescriptor } from '@eerp/core-front'

// Every entity with a registered tree (list) view, paired with the fields an
// admin may pick as its Kanban status field (type 'selection') or Calendar
// date field (type 'date') — sourced from the already-registered descriptors
// (no new backend introspection route needed; docs/roadmaps/list-view-modes.md).

export interface ViewEntityFields {
  entity: string
  kanbanFields: FieldDescriptor[]
  dateFields: FieldDescriptor[]
}

export function treeViewEntities(): ViewEntityFields[] {
  const seen = new Map<string, ViewEntityFields>()
  for (const { descriptor } of moduleRegistry.buildRegistry().values()) {
    if (descriptor.viewType !== 'tree') continue
    // Two paths (e.g. a hierarchical view and a flat fallback) can point at
    // the same entity; the field config is per-entity, so the first wins.
    if (seen.has(descriptor.entity)) continue
    seen.set(descriptor.entity, {
      entity: descriptor.entity,
      kanbanFields: descriptor.fields.filter((f) => f.type === 'selection'),
      dateFields: descriptor.fields.filter((f) => f.type === 'date'),
    })
  }
  return Array.from(seen.values())
}
