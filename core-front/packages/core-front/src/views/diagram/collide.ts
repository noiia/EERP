// Collision helpers behind the workflow map (app/app/website/workflows): keep boxes from
// sitting on one another and arrow labels from covering each other or a box. Pure, so
// the map stays a thin React Flow wrapper and these rules are unit-tested on their own.

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

/** Size a box is assumed to have before React Flow has measured it (its default node width). */
export const DEFAULT_NODE_SIZE = { width: 150, height: 40 }
/** Free space kept between two boxes. */
export const NODE_GAP = 16
/** Free space kept around a label. */
export const LABEL_GAP = 4

/** Whether `a` and `b` overlap once each is grown by `gap / 2` on every side. */
export function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap
}

/** The free position nearest to `rect`'s own: `rect` itself when nothing overlaps it,
 * else the first spot on growing rings around it (`step` px apart, closest first)
 * clear of every `others` box by `gap`. Gives `rect`'s position back if none is found. */
export function freeSpot(rect: Rect, others: Rect[], gap = NODE_GAP, step = 20, rings = 40): Point {
  const clear = (x: number, y: number) => !others.some((o) => overlaps({ ...rect, x, y }, o, gap))
  if (clear(rect.x, rect.y)) return { x: rect.x, y: rect.y }
  for (let r = 1; r <= rings; r++) {
    const spots: Point[] = []
    for (let i = -r; i <= r; i++) {
      spots.push({ x: rect.x + i * step, y: rect.y - r * step }, { x: rect.x + i * step, y: rect.y + r * step })
      if (i !== -r && i !== r) spots.push({ x: rect.x - r * step, y: rect.y + i * step }, { x: rect.x + r * step, y: rect.y + i * step })
    }
    spots.sort((a, b) => Math.hypot(a.x - rect.x, a.y - rect.y) - Math.hypot(b.x - rect.x, b.y - rect.y))
    const spot = spots.find((s) => clear(s.x, s.y))
    if (spot) return spot
  }
  return { x: rect.x, y: rect.y }
}

/** Places boxes in order: a fixed box keeps its position, the others take the free spot
 * nearest to theirs, clear of every box placed before them. Returns every position. */
export function separateBoxes(boxes: (Rect & { id: string; fixed?: boolean })[], gap = NODE_GAP): Record<string, Point> {
  const out: Record<string, Point> = {}
  const placed: Rect[] = []
  const ordered = [...boxes.filter((b) => b.fixed), ...boxes.filter((b) => !b.fixed)]
  for (const b of ordered) {
    const p = b.fixed ? { x: b.x, y: b.y } : freeSpot(b, placed, gap)
    out[b.id] = p
    placed.push({ x: p.x, y: p.y, w: b.w, h: b.h })
  }
  return out
}

// The map's arrows leave a box's right side and enter the next one's left side as React
// Flow's default bezier: these control points are its getBezierPath ones, so a point at
// `t` here lies on the drawn arrow.
const controlOffset = (distance: number) => (distance >= 0 ? 0.5 * distance : 0.25 * 25 * Math.sqrt(-distance))

/** The point at `t` (0 = source, 1 = target) on a Right → Left arrow. */
export function bezierPoint(s: Point, tg: Point, t: number): Point {
  const c1 = { x: s.x + controlOffset(tg.x - s.x), y: s.y }
  const c2 = { x: tg.x - controlOffset(tg.x - s.x), y: tg.y }
  const u = 1 - t
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t
  return { x: a * s.x + b * c1.x + c * c2.x + d * tg.x, y: a * s.y + b * c1.y + c * c2.y + d * tg.y }
}

/** Where a label sits: `t` along its arrow, then shifted by `dy` px off it. */
export interface LabelSpot { t: number; dy: number }

export interface LabelInput { id: string; source: Point; target: Point; w: number; h: number }

/** Where along its arrow each label goes, middle first, then sliding toward either end,
 * then stepping off the arrow, so no two labels and no label and box overlap. Labels are
 * placed in the given order; one with no free spot keeps the middle. */
export function placeLabels(labels: LabelInput[], boxes: Rect[], gap = LABEL_GAP): Record<string, LabelSpot> {
  const ts = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]
  const out: Record<string, LabelSpot> = {}
  const placed: Rect[] = []
  for (const l of labels) {
    const shifts = [0, 1, -1, 2, -2].map((k) => k * (l.h + gap))
    const rectAt = ({ t, dy }: LabelSpot): Rect => {
      const p = bezierPoint(l.source, l.target, t)
      return { x: p.x - l.w / 2, y: p.y + dy - l.h / 2, w: l.w, h: l.h }
    }
    let spot: LabelSpot = { t: 0.5, dy: 0 }
    search: for (const dy of shifts) {
      for (const t of ts) {
        const r = rectAt({ t, dy })
        if (!placed.some((o) => overlaps(r, o, gap)) && !boxes.some((o) => overlaps(r, o, gap))) {
          spot = { t, dy }
          break search
        }
      }
    }
    out[l.id] = spot
    placed.push(rectAt(spot))
  }
  return out
}

/** A label's size, estimated from its text (React Flow's 10px label font plus its
 * background padding): close enough to keep labels apart without measuring the DOM. */
export function labelSize(text: string): { w: number; h: number } {
  return { w: text.length * 6 + 8, h: 16 }
}

/** Whether the segment a→b crosses (or lies in) the rectangle — Liang–Barsky clipping. */
export function segmentHitsRect(a: { x: number; y: number }, b: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  let t0 = 0
  let t1 = 1
  for (const [p, q] of [[-dx, a.x - r.x], [dx, r.x + r.w - a.x], [-dy, a.y - r.y], [dy, r.y + r.h - a.y]]) {
    if (p === 0) {
      if (q < 0) return false
      continue
    }
    const t = q / p
    if (p < 0) t0 = Math.max(t0, t)
    else t1 = Math.min(t1, t)
    if (t0 > t1) return false
  }
  return true
}
