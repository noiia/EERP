import { bezierPoint, separateBoxes, type Point } from './collide'
import type { PertLink } from './pert'
import { compareOrder, type WbsNode } from './wbs'

export interface BoxSize { w: number; h: number }

const WBS_GAP_X = 40
const WBS_GAP_Y = 60
// 5 background dots (React Flow's default 20px grid): the shortest a linked arrow gets.
const PERT_GAP_X = 100
const PERT_GAP_Y = 40
/** Unlinked records per column: a longer order-number column wraps into the next ones. */
export const PERT_UNLINKED_ROWS = 10
/** Room kept between an arrow and a box it passes. */
const LINE_PAD = 8
const LINE_PASSES = 3

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

/** Two parts, left to right. Linked records: each connected group of links is its own small
 * graph, in columns (blocker left of dependent, links kept one column long where possible, empty
 * columns dropped — rankColumns), each box inline with its blockers (or, for a box nothing blocks,
 * its dependents — inline), the groups stacked top to bottom; a box an arrow would pass behind
 * moves up or down its column to the nearest free height (clearLines). Unlinked records: to their
 * right, one column per top-level order number (one column without `orderOf`), wrapped every
 * PERT_UNLINKED_ROWS records, each column centered on the linked part's middle line.
 * With `orderOf` (dotted order numbers) records go in number order, and a linked record is never
 * left of an earlier top-level number's column within its group. */
export function layoutPert(ids: string[], links: PertLink[], size: BoxSize, orderOf?: (id: string) => string | null): Record<string, Point> {
  if (orderOf) ids = [...ids].sort((a, b) => compareOrder(orderOf(a), orderOf(b)))
  const top = (id: string) => orderOf?.(id)?.split('.')[0] ?? ''
  const known = new Set(ids)
  const valid = links.filter((l) => known.has(l.from) && known.has(l.to) && l.from !== l.to)
  const blockers = new Map<string, string[]>(ids.map((i) => [i, []]))
  for (const l of valid) blockers.get(l.to)!.push(l.from)

  // Connected groups (links taken both ways), in the order of their first record.
  const root = new Map(ids.map((i) => [i, i]))
  const find = (i: string): string => {
    while (root.get(i) !== i) i = root.get(i)!
    return i
  }
  for (const l of valid) root.set(find(l.from), find(l.to))
  const linked = new Set(valid.flatMap((l) => [l.from, l.to]))
  const groups = new Map<string, string[]>()
  for (const i of ids) {
    if (!linked.has(i)) continue
    const g = find(i)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(i)
  }

  const stepX = size.w + PERT_GAP_X
  const stepY = size.h + PERT_GAP_Y
  const pos: Record<string, Point> = {}
  // Each column centered on `mid`; inside it, rows by their blockers' mean height (none: last, kept in order).
  const place = (cols: string[][], firstCol: number, mid: number) => {
    cols.forEach((col, c) => {
      const mean = (id: string) => {
        const ys = blockers.get(id)!.filter((b) => pos[b]).map((b) => pos[b].y)
        return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity
      }
      const order = col.map((id, idx) => ({ id, idx, m: mean(id) })).sort((a, b) => (a.m === b.m ? a.idx - b.idx : a.m - b.m))
      const y0 = mid - (col.length * stepY - PERT_GAP_Y) / 2
      order.forEach(({ id }, r) => {
        pos[id] = { x: (firstCol + c) * stepX, y: y0 + r * stepY }
      })
    })
  }

  let y = 0
  let width = 0
  for (const group of groups.values()) {
    const cols = rankColumns(group, valid, top)
    place(cols, 0, 0)
    inline(cols, valid, pos, stepY)
    clearLines(cols, valid, pos, size)
    // Stacked below the previous group, by its real extent once boxes moved off the arrows.
    const ys = group.map((i) => pos[i].y)
    const minY = Math.min(...ys)
    const h = Math.max(...ys) + size.h - minY
    for (const i of group) pos[i].y += y - minY
    y += h + 2 * PERT_GAP_Y
    width = Math.max(width, cols.length)
  }
  const mid = groups.size ? (y - 2 * PERT_GAP_Y) / 2 : 0

  const rest = ids.filter((i) => !linked.has(i))
  if (rest.length) {
    const tops = [...new Set(rest.map(top))]
    const cols: string[][] = tops.map(() => [])
    for (const i of rest) cols[tops.indexOf(top(i))].push(i)
    const wrapped = cols.flatMap((col) =>
      Array.from({ length: Math.ceil(col.length / PERT_UNLINKED_ROWS) }, (_, k) => col.slice(k * PERT_UNLINKED_ROWS, (k + 1) * PERT_UNLINKED_ROWS)),
    )
    // One empty column between the two parts.
    place(wrapped, width ? width + 1 : 0, mid)
  }
  return finish(pos, size)
}

// Straight arrows: each column is re-packed with every box as near as it can get to the mean
// height of its blockers (left to right), then boxes nothing blocks to their dependents' (right
// to left), then once more left to right for boxes with several blockers.
function inline(cols: string[][], links: PertLink[], pos: Record<string, Point>, stepY: number) {
  const ins = new Map<string, string[]>()
  const outs = new Map<string, string[]>()
  for (const l of links) {
    if (!pos[l.from] || !pos[l.to]) continue
    ins.set(l.to, [...(ins.get(l.to) ?? []), l.from])
    outs.set(l.from, [...(outs.get(l.from) ?? []), l.to])
  }
  const mean = (ids: string[] | undefined) => (ids?.length ? ids.reduce((a, i) => a + pos[i].y, 0) / ids.length : null)
  const byBlockers = (id: string) => mean(ins.get(id))
  const sourcesByDependents = (id: string) => (ins.get(id)?.length ? null : mean(outs.get(id)))
  for (const col of cols) pack(col, byBlockers, pos, stepY)
  for (const col of [...cols].reverse()) pack(col, sourcesByDependents, pos, stepY)
  for (const col of cols) pack(col, byBlockers, pos, stepY)
}

// Places a column's boxes `stepY` apart at the heights nearest their wanted ones (null = where
// they are), in wanted-height order: overlapping runs merge into one block centered on its
// members' wishes (pool-adjacent-violators, the least total move).
function pack(col: string[], want: (id: string) => number | null, pos: Record<string, Point>, stepY: number) {
  const items = [...col].sort((a, b) => pos[a].y - pos[b].y).map((id) => ({ id, d: want(id) ?? pos[id].y })).sort((a, b) => a.d - b.d)
  // `adj` = Σ(wish − offset in block): the block's best top is adj / size.
  const blocks: { ids: string[]; adj: number }[] = []
  for (const it of items) {
    let b = { ids: [it.id], adj: it.d }
    for (let p = blocks.at(-1); p && p.adj / p.ids.length + p.ids.length * stepY > b.adj / b.ids.length; p = blocks.at(-1)) {
      blocks.pop()
      b = { ids: [...p.ids, ...b.ids], adj: p.adj + b.adj - b.ids.length * p.ids.length * stepY }
    }
    blocks.push(b)
  }
  for (const b of blocks) b.ids.forEach((id, i) => (pos[id].y = b.adj / b.ids.length + i * stepY))
}

// An arrow spanning several columns crosses the ones between its ends: in each of them, the
// boxes it would hide behind move to the nearest height clear of every crossing arrow (traced
// as React Flow draws it, bezierPoint), keeping their order. Moving boxes bends other arrows,
// so it runs a few passes; not always perfect, never overlapping.
function clearLines(cols: string[][], links: PertLink[], pos: Record<string, Point>, size: BoxSize) {
  const colOf = new Map(cols.flatMap((c, i) => c.map((id) => [id, i] as const)))
  const long = links.filter((l) => colOf.has(l.from) && colOf.has(l.to) && colOf.get(l.to)! - colOf.get(l.from)! > 1)
  if (!long.length) return
  const center = (id: string, side: number): Point => ({ x: pos[id].x + side * size.w, y: pos[id].y + size.h / 2 })
  for (let pass = 0; pass < LINE_PASSES; pass++) {
    cols.forEach((col, c) => {
      const x0 = pos[col[0]].x - LINE_PAD
      const x1 = pos[col[0]].x + size.w + LINE_PAD
      const bands: [number, number][] = []
      for (const l of long) {
        if (colOf.get(l.from)! >= c || colOf.get(l.to)! <= c) continue
        let lo = Infinity
        let hi = -Infinity
        for (let i = 0; i <= 64; i++) {
          const p = bezierPoint(center(l.from, 1), center(l.to, 0), i / 64)
          if (p.x >= x0 && p.x <= x1) [lo, hi] = [Math.min(lo, p.y), Math.max(hi, p.y)]
        }
        if (lo <= hi) bands.push([lo - LINE_PAD, hi + LINE_PAD])
      }
      if (!bands.length) return
      let floor = -Infinity
      for (const id of [...col].sort((a, b) => pos[a].y - pos[b].y)) {
        pos[id].y = nearestFree(Math.max(pos[id].y, floor), floor, bands, size.h)
        floor = pos[id].y + size.h + PERT_GAP_Y
      }
    })
  }
}

// The height nearest `want`, at or below `floor`, where a box of height `h` touches no band
// (the bottom of the lowest band always qualifies).
function nearestFree(want: number, floor: number, bands: [number, number][], h: number): number {
  const free = (y: number) => y >= floor && !bands.some(([a, b]) => y < b && y + h > a)
  return [want, ...bands.flatMap(([a, b]) => [a - h, b])].filter(free).reduce((best, y) => (Math.abs(y - want) < Math.abs(best - want) ? y : best), Infinity)
}

// Longest-path columns of one linked group, each record at least in its top-level number's
// column (among the group's numbers); records on a cycle keep that floor. Empty columns dropped.
function rankColumns(ids: string[], links: PertLink[], top: (id: string) => string): string[][] {
  const known = new Set(ids)
  const tops = [...new Set(ids.map(top))]
  const rank = new Map(ids.map((i) => [i, tops.indexOf(top(i))]))
  const floor = new Map(rank)
  const dependents = new Map<string, string[]>(ids.map((i) => [i, []]))
  const indeg = new Map<string, number>(ids.map((i) => [i, 0]))
  for (const l of links) {
    if (!known.has(l.from)) continue
    dependents.get(l.from)!.push(l.to)
    indeg.set(l.to, indeg.get(l.to)! + 1)
  }
  const queue = ids.filter((i) => indeg.get(i) === 0)
  for (let q = 0; q < queue.length; q++) {
    for (const d of dependents.get(queue[q])!) {
      rank.set(d, Math.max(rank.get(d)!, rank.get(queue[q])! + 1))
      indeg.set(d, indeg.get(d)! - 1)
      if (indeg.get(d) === 0) queue.push(d)
    }
  }
  const sorted = new Set(queue)
  for (const i of ids) if (!sorted.has(i)) rank.set(i, floor.get(i)!)
  // Shorter arrows: a box with more dependents than blockers moves right, next to its nearest
  // dependent (dependents first, so each sees its dependents' final column).
  const blockerCount = new Map<string, number>(ids.map((i) => [i, 0]))
  for (const l of links) if (known.has(l.from)) blockerCount.set(l.to, blockerCount.get(l.to)! + 1)
  for (let q = queue.length - 1; q >= 0; q--) {
    const deps = dependents.get(queue[q])!
    if (deps.length > blockerCount.get(queue[q])!) rank.set(queue[q], Math.max(rank.get(queue[q])!, Math.min(...deps.map((d) => rank.get(d)!)) - 1))
  }
  const cols: string[][] = []
  for (const i of ids) (cols[rank.get(i)!] ??= []).push(i)
  return cols.filter(Boolean)
}

function finish(pos: Record<string, Point>, size: BoxSize, heightOf: (id: string) => number = () => size.h): Record<string, Point> {
  return separateBoxes(Object.entries(pos).map(([id, p]) => ({ id, ...p, w: size.w, h: heightOf(id) })))
}
