import { separateBoxes, type Point } from './collide'
import type { PertLink } from './pert'
import { compareOrder, type WbsNode } from './wbs'

export interface BoxSize { w: number; h: number }

const WBS_GAP_X = 40
const WBS_GAP_Y = 60
const PERT_GAP_X = 80
const PERT_GAP_Y = 40

/** Top-down tidy tree: leaves take consecutive x slots, a parent centers over its visible children.
 * Each depth row is as tall as its tallest box (`heightOf`, default `size.h`), so a short row (WBS
 * group roots) keeps the same gap below it as any other. */
export function layoutWbs(
  nodes: Record<string, WbsNode>,
  roots: string[],
  visible: string[],
  size: BoxSize,
  heightOf: (id: string) => number = () => size.h,
): Record<string, Point> {
  const vis = new Set(visible)
  const rowH: number[] = []
  for (const id of visible) rowH[nodes[id].depth] = Math.max(rowH[nodes[id].depth] ?? 0, heightOf(id))
  const rowY: number[] = []
  for (let d = 0, y = 0; d < rowH.length; d++) { rowY[d] = y; y += (rowH[d] ?? 0) + WBS_GAP_Y }
  const pos: Record<string, Point> = {}
  let slot = 0
  const place = (id: string): void => {
    const kids = nodes[id].children.filter((c) => vis.has(c))
    kids.forEach(place)
    const x = kids.length ? (pos[kids[0]].x + pos[kids[kids.length - 1]].x) / 2 : slot++ * (size.w + WBS_GAP_X)
    pos[id] = { x, y: rowY[nodes[id].depth] }
  }
  roots.filter((r) => vis.has(r)).forEach(place)
  return finish(pos, size, heightOf)
}

/** Longest-path columns (blocker left of dependent), one barycenter sweep for rows. With
 * `orderOf` (dotted order numbers), a record is also never left of its top-level number's
 * column: the 1.x records start the chart, the highest number ends it. */
export function layoutPert(ids: string[], links: PertLink[], size: BoxSize, orderOf?: (id: string) => string | null): Record<string, Point> {
  if (orderOf) ids = [...ids].sort((a, b) => compareOrder(orderOf(a), orderOf(b)))
  const tops = orderOf ? [...new Set(ids.map((i) => orderOf(i)?.split('.')[0]).filter((t): t is string => !!t))] : []
  const known = new Set(ids)
  const blockers = new Map<string, string[]>(ids.map((i) => [i, []]))
  const dependents = new Map<string, string[]>(ids.map((i) => [i, []]))
  const indeg = new Map<string, number>(ids.map((i) => [i, 0]))
  for (const l of links) {
    if (!known.has(l.from) || !known.has(l.to) || l.from === l.to) continue
    blockers.get(l.to)!.push(l.from)
    dependents.get(l.from)!.push(l.to)
    indeg.set(l.to, indeg.get(l.to)! + 1)
  }
  const rank = new Map<string, number>(ids.map((i) => [i, Math.max(0, tops.indexOf(orderOf?.(i)?.split('.')[0] ?? ''))]))
  const queue = ids.filter((i) => indeg.get(i) === 0)
  for (let q = 0; q < queue.length; q++) {
    for (const d of dependents.get(queue[q])!) {
      rank.set(d, Math.max(rank.get(d)!, rank.get(queue[q])! + 1))
      indeg.set(d, indeg.get(d)! - 1)
      if (indeg.get(d) === 0) queue.push(d)
    }
  }
  // Nodes left out of the queue sit on or behind a cycle: they keep rank 0.
  for (const i of ids) if (!queue.includes(i)) rank.set(i, 0)

  const cols: string[][] = []
  for (const i of ids) (cols[rank.get(i)!] ??= []).push(i)
  const row = new Map<string, number>()
  const pos: Record<string, Point> = {}
  cols.forEach((col, c) => {
    if (!col) return
    const mean = (id: string) => {
      const bs = blockers.get(id)!.filter((b) => row.has(b))
      return bs.length ? bs.reduce((s, b) => s + row.get(b)!, 0) / bs.length : Infinity
    }
    const order = col.map((id, idx) => ({ id, idx, m: mean(id) }))
      .sort((a, b) => (a.m === b.m ? a.idx - b.idx : a.m - b.m))
    order.forEach(({ id }, r) => {
      row.set(id, r)
      pos[id] = { x: c * (size.w + PERT_GAP_X), y: r * (size.h + PERT_GAP_Y) }
    })
  })
  return finish(pos, size)
}

function finish(pos: Record<string, Point>, size: BoxSize, heightOf: (id: string) => number = () => size.h): Record<string, Point> {
  return separateBoxes(Object.entries(pos).map(([id, p]) => ({ id, ...p, w: size.w, h: heightOf(id) })))
}
