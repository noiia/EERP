import type { NodeId, WfEdge, WfNode, WfProblem } from './workflow'

// Pure helpers behind the workflow map (app/app/website/workflows): where each node
// sits and which nodes/edges a problem colors. Positions are never stored (v1).

export interface Cell { col: number; row: number }

/** Left-to-right layout: columns are the BFS depth from the home page (`page:`), or
 * from the menu pages when there is no home page; rows follow the visit order.
 * Nodes no root reaches go in one last column, in their given order. */
export function layoutWorkflow(nodes: WfNode[], edges: WfEdge[]): Record<string, Cell> {
  const out: Record<string, Cell> = {}
  const next = new Map<NodeId, NodeId[]>()
  for (const e of edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to])
  const home = nodes.find((n) => n.id === 'page:')
  const roots = home ? [home.id] : nodes.filter((n) => n.inMenu).map((n) => n.id)

  const rows: number[] = []
  const place = (id: NodeId, col: number) => {
    rows[col] = (rows[col] ?? 0) + 1
    out[id] = { col, row: rows[col] - 1 }
  }
  let maxDepth = -1
  const queue: { id: NodeId; depth: number }[] = []
  for (const id of roots) { place(id, 0); queue.push({ id, depth: 0 }) }
  for (let i = 0; i < queue.length; i++) {
    const { id, depth } = queue[i]
    maxDepth = Math.max(maxDepth, depth)
    for (const to of next.get(id) ?? []) {
      if (out[to]) continue
      place(to, depth + 1)
      queue.push({ id: to, depth: depth + 1 })
    }
  }
  for (const n of nodes) if (!out[n.id]) place(n.id, maxDepth + 1)
  return out
}

export type Level = WfProblem['level']

/** The level each node and edge is drawn with: a problem naming an edge colors that
 * edge, one naming only a node colors the node; a missing page is always an error. */
export function problemLevels(nodes: WfNode[], problems: WfProblem[]): { nodes: Map<NodeId, Level>; edges: Map<string, Level> } {
  const byNode = new Map<NodeId, Level>()
  const byEdge = new Map<string, Level>()
  const raise = <K,>(m: Map<K, Level>, k: K, level: Level) => { if (m.get(k) !== 'error') m.set(k, level) }
  for (const n of nodes) if (n.missing) raise(byNode, n.id, 'error')
  for (const p of problems) {
    if (p.edgeId) raise(byEdge, p.edgeId, p.level)
    else if (p.nodeId) raise(byNode, p.nodeId, p.level)
  }
  return { nodes: byNode, edges: byEdge }
}
