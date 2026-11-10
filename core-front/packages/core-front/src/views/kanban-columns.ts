import type { KanbanColumnsConfig } from '../api/view-fields'
import type { RelationRecord } from './relation-ops'

// Kanban columns built from many2one records (Odoo-style editable stages):
// the pure grouping/drop-target logic behind KanbanRenderer's many2one path,
// plus the named guard registry deciding who may edit the columns.

/** One board column: one column record, or (unscoped) every record sharing a label. */
export interface KanbanColumn {
  /** Stable key: the (first) record's id. */
  key: string
  label: string
  /** Minimum orderField among its records. */
  order: number
  /** Collapsed: every one of its records has a truthy foldField. */
  fold: boolean
  /** Its column records, in orderField order. */
  stages: RelationRecord[]
}

function orderOf(record: RelationRecord, config: KanbanColumnsConfig): number {
  const n = Number(record[config.orderField])
  return Number.isFinite(n) ? n : 0
}

function labelOf(record: RelationRecord, config: KanbanColumnsConfig): string {
  return String(record[config.labelField] ?? '')
}

function toColumn(stages: RelationRecord[], config: KanbanColumnsConfig): KanbanColumn {
  return {
    key: stages[0]!.id,
    label: labelOf(stages[0]!, config),
    order: orderOf(stages[0]!, config),
    fold: Boolean(config.foldField) && stages.every((s) => Boolean(s[config.foldField!])),
    stages,
  }
}

function sortStages(records: RelationRecord[], config: KanbanColumnsConfig): RelationRecord[] {
  return [...records].sort(
    (a, b) => orderOf(a, config) - orderOf(b, config) || labelOf(a, config).localeCompare(labelOf(b, config)),
  )
}

/** Scoped board: one column per record, in orderField order. */
export function splitColumns(records: RelationRecord[], config: KanbanColumnsConfig): KanbanColumn[] {
  return sortStages(records, config).map((s) => toColumn([s], config))
}

/** Unscoped board: records sharing a label become one column, ordered by their minimum orderField. */
export function mergeColumnsByLabel(records: RelationRecord[], config: KanbanColumnsConfig): KanbanColumn[] {
  const groups = new Map<string, RelationRecord[]>()
  for (const s of sortStages(records, config)) {
    const label = labelOf(s, config)
    groups.set(label, [...(groups.get(label) ?? []), s])
  }
  // Map insertion order follows the sorted records, so groups come out by minimum order.
  return [...groups.values()].map((stages) => toColumn(stages, config))
}

/**
 * The column record a card dropped into `column` should point at: the one in
 * the card's own scope, or null when that scope has no record with the label.
 * Without a scopeField every record is interchangeable — take the first.
 */
export function resolveDropTarget(column: KanbanColumn, cardScope: unknown, config: KanbanColumnsConfig): string | null {
  if (!config.scopeField) return column.stages[0]?.id ?? null
  return column.stages.find((s) => s[config.scopeField!] === cardScope)?.id ?? null
}

type KanbanColumnsGuard = (scopeId: string) => Promise<boolean>

const guards = new Map<string, KanbanColumnsGuard>()

/** Register the check deciding whether the caller may add/rename/reorder a scope's columns (by name — descriptors stay JSON). */
export function registerKanbanColumnsGuard(name: string, fn: KanbanColumnsGuard): void {
  guards.set(name, fn)
}

/** The guard registered under `name`, if any. */
export function kanbanColumnsGuard(name: string): KanbanColumnsGuard | undefined {
  return guards.get(name)
}
