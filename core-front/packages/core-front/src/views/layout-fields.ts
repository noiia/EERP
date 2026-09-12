import { layoutFieldOrder, normalizeLayout, type FieldDescriptor, type ViewDescriptor } from './descriptor'
import type { HasId } from './stores'

// Shared by KanbanRenderer and CalendarRenderer (docs/roadmaps/list-view-modes.md):
// which fields to show on a card/day entry, in normalized layout order — the
// same "first field is the natural label" heuristic HierarchyTree already
// uses for a tree node's own label, generalized to also drop the field the
// renderer itself already encodes (the Kanban column / Calendar's own date).

export function orderedFields<T extends HasId>(
  descriptor: ViewDescriptor<T>,
  { exclude = [], limit }: { exclude?: string[]; limit?: number } = {},
): FieldDescriptor[] {
  const fieldsByName = new Map(descriptor.fields.map((f) => [f.name, f]))
  const ordered = layoutFieldOrder(normalizeLayout(descriptor))
    .filter((name) => !exclude.includes(name))
    .map((name) => fieldsByName.get(name))
    .filter((f): f is FieldDescriptor => f != null)
  return limit != null ? ordered.slice(0, limit) : ordered
}
