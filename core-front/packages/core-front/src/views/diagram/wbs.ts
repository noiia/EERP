export interface WbsInput { id: string; parentId: string | null; order?: string | null; groupId?: string | null; groupLabel?: string; plannedHours?: number | null; closed?: boolean }
export interface WbsNode { id: string; kind: 'group' | 'task'; parentId: string | null; children: string[]; depth: number; hiddenCount: number; hiddenHours: number }

const GROUP = 'group:'

/** Dotted order numbers compared segment by segment ("2.10" after "2.9"); none sorts last. */
export function compareOrder(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]
  return x.length - y.length
}

export function buildWbs(input: WbsInput[], folded: ReadonlySet<string>): { nodes: Record<string, WbsNode>; roots: string[]; visible: string[] } {
  const rows = [...input].sort((a, b) => compareOrder(a.order, b.order)) // stable: unnumbered keep input order
  const nodes: Record<string, WbsNode> = {}
  const roots: string[] = []
  const byId = new Map(rows.map((r) => [r.id, r]))
  const parentOf: Record<string, string | null> = {}

  const link = (id: string, parent: string | null) => {
    if (parent) nodes[parent].children.push(id)
    else roots.push(id)
  }
  // Group roots first, in order of first appearance.
  for (const r of rows) {
    if (!r.groupId) continue
    const gid = GROUP + r.groupId
    if (!nodes[gid]) {
      nodes[gid] = { id: gid, kind: 'group', parentId: null, children: [], depth: 0, hiddenCount: 0, hiddenHours: 0 }
      roots.push(gid)
    }
  }
  for (const r of rows) nodes[r.id] = { id: r.id, kind: 'task', parentId: null, children: [], depth: 0, hiddenCount: 0, hiddenHours: 0 }

  // Effective parent. A cycle (a->b->a) is broken at the first row (input order) that would close it:
  // that row becomes a root (or hangs under its group).
  for (const r of rows) {
    let p: string | null = r.parentId && r.parentId !== r.id && byId.has(r.parentId) ? r.parentId : null
    for (let cur = p; cur; cur = parentOf[cur] ?? null) {
      if (cur === r.id) { p = null; break }
    }
    parentOf[r.id] = p
    nodes[r.id].parentId = p ?? (r.groupId ? GROUP + r.groupId : null)
  }
  for (const r of rows) link(r.id, nodes[r.id].parentId)

  const visible: string[] = []
  // Returns [count, hours] of the node's descendants.
  const walk = (id: string, depth: number, hidden: boolean): [number, number] => {
    const n = nodes[id]
    n.depth = depth
    if (!hidden) visible.push(id)
    let count = 0
    let h = 0
    for (const c of n.children) {
      const [dc, dh] = walk(c, depth + 1, hidden || folded.has(id))
      count += 1 + dc
      h += (byId.get(c)?.plannedHours ?? 0) + dh
    }
    if (folded.has(id)) { n.hiddenCount = count; n.hiddenHours = h }
    return [count, h]
  }
  for (const r of roots) walk(r, 0, false)
  return { nodes, roots, visible }
}

// A `group:` id (or null) means "clear the parent". Self, descendants and unknown ids are refused.
export function canReparent(nodes: Record<string, WbsNode>, taskId: string, newParentId: string | null): boolean {
  const t = nodes[taskId]
  if (!t || t.kind !== 'task') return false
  if (newParentId === null || newParentId.startsWith(GROUP)) return true
  if (!nodes[newParentId]) return false
  for (let cur: string | null = newParentId; cur; cur = nodes[cur]?.parentId ?? null) {
    if (cur === taskId) return false
  }
  return true
}
