export interface PertTaskInput { id: string; plannedHours?: number | null; dateStart?: string | null; deadline?: string | null }
export interface PertLink { from: string; to: string } // from = blocker, to = dependent
export interface PertNode { id: string; duration: number; noEstimate: boolean; es: number; ef: number; ls: number; lf: number; slack: number; critical: boolean }
export interface PertResult { nodes: Record<string, PertNode>; criticalLinks: Set<string>; hiddenLinks: number; cycle: string[] | null; origin: Date; finish: number }

export const HOURS_PER_DAY = 8
const DAY_MS = 86_400_000
const EPS = 1e-6

// Dates are absolute instants (ISO with offset), so ms / 86400000 never drifts with local DST.
export function taskDuration(t: PertTaskInput): { days: number; noEstimate: boolean } {
  if (t.plannedHours != null && t.plannedHours > 0) return { days: t.plannedHours / HOURS_PER_DAY, noEstimate: false }
  if (t.dateStart && t.deadline) {
    const d = (Date.parse(t.deadline) - Date.parse(t.dateStart)) / DAY_MS
    if (d > 0) return { days: d, noEstimate: false }
  }
  return { days: 1, noEstimate: true }
}

export function offsetToDate(origin: Date, days: number): Date {
  return new Date(origin.getTime() + days * DAY_MS)
}

export function computePert(tasks: PertTaskInput[], links: PertLink[], today: Date = new Date()): PertResult {
  const starts = tasks.map((t) => (t.dateStart ? Date.parse(t.dateStart) : NaN)).filter((n) => !Number.isNaN(n))
  const origin = starts.length
    ? new Date(Math.min(...starts))
    : new Date(today.getFullYear(), today.getMonth(), today.getDate())

  const nodes: Record<string, PertNode> = {}
  for (const t of tasks) {
    const { days, noEstimate } = taskDuration(t)
    nodes[t.id] = { id: t.id, duration: days, noEstimate, es: 0, ef: 0, ls: 0, lf: 0, slack: 0, critical: false }
  }
  const used: PertLink[] = []
  let hiddenLinks = 0
  for (const l of links) {
    if (nodes[l.from] && nodes[l.to]) used.push(l)
    else hiddenLinks++
  }
  const out = new Map<string, string[]>()
  const inn = new Map<string, string[]>()
  for (const id of Object.keys(nodes)) { out.set(id, []); inn.set(id, []) }
  for (const l of used) { out.get(l.from)!.push(l.to); inn.get(l.to)!.push(l.from) }

  // Kahn
  const deg = new Map([...inn].map(([id, b]) => [id, b.length]))
  const order: string[] = []
  const queue = [...deg].filter(([, d]) => d === 0).map(([id]) => id)
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const n of out.get(id)!) {
      deg.set(n, deg.get(n)! - 1)
      if (deg.get(n) === 0) queue.push(n)
    }
  }
  if (order.length < Object.keys(nodes).length) {
    // Leftovers include nodes merely downstream of a cycle; strip those (no leftover successor) to keep only the cycle.
    let rest = Object.keys(nodes).filter((id) => !order.includes(id))
    for (let changed = true; changed; ) {
      const next = rest.filter((id) => out.get(id)!.some((s) => rest.includes(s)))
      changed = next.length !== rest.length
      rest = next
    }
    return { nodes, criticalLinks: new Set(), hiddenLinks, cycle: rest, origin, finish: 0 }
  }

  for (const id of order) {
    const n = nodes[id]
    n.es = Math.max(0, ...inn.get(id)!.map((b) => nodes[b].ef))
    n.ef = n.es + n.duration
  }
  const finish = Math.max(0, ...order.map((id) => nodes[id].ef))
  for (const id of [...order].reverse()) {
    const n = nodes[id]
    n.lf = Math.min(finish, ...out.get(id)!.map((s) => nodes[s].ls))
    n.ls = n.lf - n.duration
    n.slack = n.ls - n.es
    n.critical = n.slack < EPS
  }
  const criticalLinks = new Set<string>()
  for (const l of used) {
    const a = nodes[l.from], b = nodes[l.to]
    if (a.critical && b.critical && Math.abs(a.ef - b.es) < EPS) criticalLinks.add(`${l.from}->${l.to}`)
  }
  return { nodes, criticalLinks, hiddenLinks, cycle: null, origin, finish }
}
