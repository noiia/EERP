import type { Block, BlockType } from './types'

// Pure layout edits for the page editor. Blocks live on a 36-column grid of 12px
// rows with 8px gaps (StackedGrid renders the same); react-grid-layout reports
// geometry as { i, x, y, w, h } by block id.
export const GRID = { cols: 36, rowHeight: 12, gap: 8 }
/** A block's height in px for `h` grid rows. */
export const rowsPx = (h: number) => h * GRID.rowHeight + (h - 1) * GRID.gap

const DEFAULTS: Record<BlockType, { w: number; h: number; config: () => Record<string, unknown> }> = {
  text: { w: 36, h: 6, config: () => ({ body: '' }) },
  hero: { w: 36, h: 12, config: () => ({ title: '' }) },
  image: { w: 18, h: 12, config: () => ({ table: '', record: '', field: '', alt: '' }) },
  record_list: { w: 36, h: 18, config: () => ({ table: '', fields: [], title_field: '', display: 'grid', page_size: 12 }) },
  record_detail: { w: 36, h: 18, config: () => ({ table: '', fields: [], title_field: '' }) },
  record_carousel: { w: 36, h: 18, config: () => ({ table: '', fields: [], title_field: '', limit: 10 }) },
  image_carousel: { w: 36, h: 18, config: () => ({ table: '', picture_field: '', limit: 10 }) },
  event_booking: { w: 36, h: 18, config: () => ({}) },
  appointment_booking: { w: 36, h: 18, config: () => ({}) },
  event_list: { w: 36, h: 18, config: () => ({ display: 'cards', limit: 12 }) },
}

/** Appends a block of `type` below the lowest one, with that type's default size and config. */
export function addBlock(layout: Block[], type: BlockType): Block[] {
  const d = DEFAULTS[type]
  const y = Math.max(0, ...layout.map((b) => b.y + b.h))
  return [...layout, { id: `b-${crypto.randomUUID().slice(0, 8)}`, type, x: 0, y, w: d.w, h: d.h, config: d.config() }]
}

export const removeBlock = (layout: Block[], id: string): Block[] => layout.filter((b) => b.id !== id)

export function applyGeometry(layout: Block[], rgl: readonly { i: string; x: number; y: number; w: number; h: number }[]): Block[] {
  const byId = new Map(rgl.map((g) => [g.i, g]))
  return layout.map((b) => {
    const g = byId.get(b.id)
    return g ? { ...b, x: g.x, y: g.y, w: g.w, h: g.h } : b
  })
}

export const updateConfig = (layout: Block[], id: string, config: Record<string, unknown>): Block[] =>
  layout.map((b) => (b.id === id ? { ...b, config } : b))
