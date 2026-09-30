// Keep in sync with core/modules/website/validate.go BlockTypes.
export const BLOCK_TYPES = ['text', 'image', 'hero', 'record_list', 'record_detail', 'record_carousel', 'event_booking', 'appointment_booking'] as const
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
export interface HeroConfig {
  title: string; subtitle?: string; cta_label?: string; cta_href?: string
  /** Horizontal / vertical placement of the content inside the block (default center / center). */
  align?: 'left' | 'center' | 'right'; valign?: 'top' | 'center' | 'bottom'
  /** Button size (default large) and width: its text width, or the block's full width. */
  button_size?: 'small' | 'medium' | 'large'; button_width?: 'auto' | 'full'
  /** Inner padding (default normal). */
  padding?: 'none' | 'compact' | 'normal' | 'spacious'
}
export interface RecordListConfig {
  table: string; fields: string[]; title_field: string; filter?: Record<string, string>
  page_size?: number; display?: 'grid' | 'list'; detail_slug?: string; picture_field?: string
}
/** event_booking / appointment_booking: the event to book. */
export interface BookingConfig { event_id: string }
/** `record`: a fixed record to show; unset = the id from the URL (/<slug>/<id>). */
export interface RecordDetailConfig { table: string; fields: string[]; title_field: string; picture_field?: string; record?: string }
/** `records`: hand-picked ids, in order; unset = the table's first ones. `limit` caps either. */
export interface RecordCarouselConfig {
  table: string; fields: string[]; title_field: string; picture_field?: string; detail_slug?: string
  records?: string[]; limit?: number; filter?: Record<string, string>
}

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
