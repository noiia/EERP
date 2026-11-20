/** One Gantt row placed in the parent/child tree. */
export interface TreeRow<R> { row: R; depth: number; hasChildren: boolean }

/** Orders `rows` as a tree (each row under its parent, siblings kept in the given order)
 * and drops the descendants of `collapsed` rows. A row whose parent isn't among `rows`
 * (another range, filtered out) is a root; a parent cycle is cut where it closes. */
export function ganttTree<R>(rows: R[], idOf: (r: R) => string, parentOf: (r: R) => string | null, collapsed: ReadonlySet<string>): TreeRow<R>[] {
  const ids = new Set(rows.map(idOf))
  const kids = new Map<string | null, R[]>()
  for (const r of rows) {
    const p = parentOf(r)
    const key = p && p !== idOf(r) && ids.has(p) ? p : null
    kids.set(key, [...(kids.get(key) ?? []), r])
  }
  const out: TreeRow<R>[] = []
  const seen = new Set<string>()
  const walk = (r: R, depth: number, hidden: boolean) => {
    const id = idOf(r)
    if (seen.has(id)) return
    seen.add(id)
    const children = kids.get(id) ?? []
    if (!hidden) out.push({ row: r, depth, hasChildren: children.length > 0 })
    for (const c of children) walk(c, depth + 1, hidden || collapsed.has(id))
  }
  for (const r of kids.get(null) ?? []) walk(r, 0, false)
  // Rows only reachable through a cycle: shown as roots.
  for (const r of rows) walk(r, 0, false)
  return out
}
