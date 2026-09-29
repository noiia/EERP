// Keep in sync with core/modules/website/validate.go BlockTypes.
export const BLOCK_TYPES = ['text', 'image', 'hero', 'record_list', 'record_detail', 'event_booking', 'appointment_booking'] as const
export type BlockType = (typeof BLOCK_TYPES)[number]

export interface Block {
  id: string
  type: BlockType
  x: number
  y: number
  w: number
  h: number
  config: Record<string, unknown>
}

export interface TextConfig { heading?: string; body: string; align?: 'left' | 'center' | 'right' }
export interface ImageConfig { table: string; record: string; field: string; alt: string; href?: string }
export interface HeroConfig { title: string; subtitle?: string; cta_label?: string; cta_href?: string }
export interface RecordListConfig {
  table: string; fields: string[]; title_field: string; filter?: Record<string, string>
  page_size?: number; display?: 'grid' | 'list'; detail_slug?: string; picture_field?: string
}
export interface RecordDetailConfig { table: string; fields: string[]; title_field: string; picture_field?: string }

/** Where blocks read published data — the public API server-side, a Server
 * Action in the editor. null = table not published (404). */
export interface PublicDataSource {
  list(table: string, q: { filter?: Record<string, string>; page_size?: number }): Promise<{ records: Record<string, unknown>[]; total: number } | null>
  get(table: string, id: string): Promise<Record<string, unknown> | null>
}

/** Phone order: top-to-bottom, then left-to-right of the desktop grid. */
export function stackOrder(blocks: Block[]): Block[] {
  return [...blocks].sort((a, b) => a.y - b.y || a.x - b.x)
}
