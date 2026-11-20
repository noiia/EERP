// The review list's tick state (ADR-042). Pure, and every function returns a new
// Set: the wizard holds one Set in state and derives the next from it, so a tick
// never mutates what a still-rendering row already read.
//
// The one rule the whole file exists for: a ticked row's `requires` stay ticked.
// The apply refuses a selection that breaks it (422 with the offending keys), so
// ticking a row pulls in what it needs, and unticking one drops whatever needed
// it — a half-ticked cluster is a state the manager cannot reach by clicking.

/** One row of the preview's `changes` (see core/modules/project/exchange_diff.go). */
export interface ExchangeChange {
  key: string
  kind: string
  /** The label the wizard groups the row under. */
  task: string
  wbs?: string
  field?: string
  before: unknown
  after: unknown
  default_selected: boolean
  /** Keys this row cannot apply without (its new parent, a delete's own subtask deletes). */
  requires?: string[]
  was_unscheduled?: boolean
  dependents?: { subtasks: number; timesheets: number; risk_links: number }
}

/**
 * Does this row destroy something? Every `…_delete` kind and `delete`, and a task
 * losing its milestone link (the field set to null reads as an unlink, not an edit).
 * These never arrive pre-selected and "Select all" leaves them alone.
 */
export const isRemoval = (c: ExchangeChange): boolean =>
  c.kind === 'delete' || c.kind.endsWith('_delete') || (c.field === 'milestone_id' && c.after == null)

/** key → the keys it needs, and key → the keys that need it, over the rows the preview sent. */
function indexes(changes: ExchangeChange[]): {
  known: Set<string>
  requires: Map<string, string[]>
  requiredBy: Map<string, string[]>
} {
  const known = new Set(changes.map((c) => c.key))
  const requires = new Map<string, string[]>()
  const requiredBy = new Map<string, string[]>()
  for (const c of changes) {
    // A requires naming a row the preview never sent (or the row itself) is a backend
    // slip; posting such a key to apply would only earn a 422, so it is dropped here.
    requires.set(c.key, (c.requires ?? []).filter((r) => r !== c.key && known.has(r)))
  }
  for (const c of changes)
    for (const r of requires.get(c.key)!) {
      const list = requiredBy.get(r)
      if (list) list.push(c.key)
      else requiredBy.set(r, [c.key])
    }
  return { known, requires, requiredBy }
}

/** The seeds plus, transitively, everything they require (or everything that requires them). */
function closure(seeds: string[], next: Map<string, string[]>, known: Set<string>): Set<string> {
  const out = new Set<string>(seeds.filter((k) => known.has(k)))
  const stack = [...out]
  while (stack.length) {
    for (const k of next.get(stack.pop()!) ?? []) {
      if (!out.has(k) && known.has(k)) {
        out.add(k)
        stack.push(k)
      }
    }
  }
  return out
}

/**
 * The rows to start with: the preview's `default_selected` ones and everything they
 * require, transitively. A removal never seeds the selection — nothing that
 * destroys data arrives pre-ticked, even if a preview flagged one selected.
 */
export function initialSelection(changes: ExchangeChange[]): Set<string> {
  const { known, requires } = indexes(changes)
  return closure(
    changes.filter((c) => c.default_selected && !isRemoval(c)).map((c) => c.key),
    requires,
    known,
  )
}

/** Tick a row with all it needs; untick it and everything that needed it. */
export function toggle(changes: ExchangeChange[], sel: Set<string>, key: string, on: boolean): Set<string> {
  const { known, requires, requiredBy } = indexes(changes)
  if (on) return new Set([...sel, ...closure([key], requires, known)])
  const doomed = closure([key], requiredBy, known)
  return new Set([...sel].filter((k) => !doomed.has(k)))
}

/** Every additive row, in or out. A removal is never added and never removed here. */
export function selectAll(changes: ExchangeChange[], sel: Set<string>, on: boolean): Set<string> {
  const additive = changes.filter((c) => !isRemoval(c)).map((c) => c.key)
  if (on) return new Set([...sel, ...additive])
  const doomed = new Set(additive)
  return new Set([...sel].filter((k) => !doomed.has(k)))
}

/** The destructive rows, ticked with what each one needs (its subtask deletes). */
export function selectAllRemovals(changes: ExchangeChange[], sel: Set<string>, on: boolean): Set<string> {
  const { known, requires, requiredBy } = indexes(changes)
  const removals = changes.filter(isRemoval).map((c) => c.key)
  if (on) return new Set([...sel, ...closure(removals, requires, known)])
  const doomed = closure(removals, requiredBy, known)
  return new Set([...sel].filter((k) => !doomed.has(k)))
}
