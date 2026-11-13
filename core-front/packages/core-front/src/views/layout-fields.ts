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
    // Geo (a map) and distance (a computed widget) values have no text form:
    // they'd print as "[object Object]"/blank on a card or label.
    .filter((f): f is FieldDescriptor => f != null && f.type !== 'geo' && f.type !== 'distance')
  return limit != null ? ordered.slice(0, limit) : ordered
}

/** The record's name field ("name", else "title"), the one an order number is shown with. */
export const nameFieldOf = (record: Record<string, unknown>): string | undefined =>
  ['name', 'title'].find((k) => typeof record[k] === 'string' && record[k] !== '')

/** How List, Kanban and Calendar show the `wbsOrderField`: "<order> - <name>", since a
 * number alone names nothing (just the name while unnumbered). null for any other field. */
export function orderLabel<T extends HasId>(descriptor: ViewDescriptor<T>, field: string, record: Record<string, unknown>): string | null {
  if (!field || field !== descriptor.viewModeDefaults?.wbsOrderField) return null
  const order = typeof record[field] === 'string' ? (record[field] as string) : ''
  const nameKey = nameFieldOf(record)
  const name = nameKey ? (record[nameKey] as string) : ''
  return order && name ? `${order} - ${name}` : order || name
}
