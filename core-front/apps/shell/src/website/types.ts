// Keep in sync with core/modules/website/validate.go BlockTypes.
export const BLOCK_TYPES = ['text', 'image', 'hero', 'record_list', 'record_detail', 'record_carousel', 'image_carousel', 'event_booking', 'appointment_booking', 'event_list', 'section'] as const
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
/** Title, subtitle and button laid over a block (hero, image, section): only the set parts render. */
export interface HeroConfig {
  title?: string; subtitle?: string; cta_label?: string; cta_href?: string
  /** Horizontal / vertical placement of the content inside the block (default center / center). */
  align?: 'left' | 'center' | 'right'; valign?: 'top' | 'center' | 'bottom'
  /** Button size (default large) and width: its text width, or the block's full width. */
  button_size?: 'small' | 'medium' | 'large'; button_width?: 'auto' | 'full'
  /** Inner padding (default normal). */
  padding?: 'none' | 'compact' | 'normal' | 'spacious'
}
/** A record's picture (`record` unset = the table's first record holding one), filling
 * the block; optional hero content laid over it on a dark scrim. */
export interface ImageConfig extends HeroConfig {
  table: string; record: string; field: string; alt: string; href?: string
  /** cover (default) crops to fill the block; contain shows the whole picture. */
  fit?: 'cover' | 'contain'
}
/** A background band: its color and/or a record's picture (optionally fixed while the
 * page scrolls — parallax). Blocks overlapping it render on top; it can carry its own
 * hero content. */
export interface SectionConfig extends HeroConfig {
  color?: string
  table?: string; record?: string; field?: string
  parallax?: boolean
  /** Picture darkening, 0–80 % (default 30 when the section has content, else 0). */
  dim?: number
}
export interface RecordListConfig {
  table: string; fields: string[]; title_field: string; filter?: Record<string, string>
  page_size?: number; display?: 'grid' | 'list'; detail_slug?: string; picture_field?: string
}
/** event_booking / appointment_booking: the event to book; unset = the id from the URL
 * (/<slug>/<id>, what an event_list's `detail_slug` links to). */
export interface BookingConfig { event_id?: string }
/** event_list: upcoming published events (Go's /public/events/upcoming), as cards or a
 * list, each linking to `/<detail_slug>/<id>` when set. `limit` caps it (1–50, default 12). */
export interface EventListConfig { display?: 'cards' | 'list'; limit?: number; detail_slug?: string }
/** `record`: a fixed record to show; unset = the id from the URL (/<slug>/<id>). */
export interface RecordDetailConfig {
  table: string; fields: string[]; title_field: string; picture_field?: string; record?: string
  related?: RelatedConfig
}
/** A table whose rows point at the detail's record (`link_field` holds its id), shown
 * as a picker on the detail — e.g. product_variant by product_id. */
interface RelatedConfig { table: string; link_field: string; fields: string[]; title_field: string; picture_field?: string }
/** Pictures of hand-picked records (in order) or the table's first ones, capped at `limit`. */
export interface ImageCarouselConfig {
  table: string; picture_field: string; title_field?: string; detail_slug?: string
  records?: string[]; limit?: number; filter?: Record<string, string>
}
/** `records`: hand-picked ids, in order; unset = the table's first ones. `limit` caps either. */
export interface RecordCarouselConfig {
  table: string; fields: string[]; title_field: string; picture_field?: string; detail_slug?: string
  records?: string[]; limit?: number; filter?: Record<string, string>
  /** Where the card's picture sits (default top) and, beside the text, its width in % (default 40). */
  picture_position?: 'top' | 'left' | 'right'; picture_width?: number
  /** Card width in px on the row (default 280). */
  card_width?: number
}

/** Where blocks read published data — the public API server-side, a Server
 * Action in the editor. null = table not published (404). */
export interface PublicDataSource {
  list(table: string, q: { filter?: Record<string, string>; page_size?: number }): Promise<{ records: Record<string, unknown>[]; total: number } | null>
  get(table: string, id: string): Promise<Record<string, unknown> | null>
}

/** Phone order: top-to-bottom, then left-to-right of the desktop grid; a section
 * before the blocks starting with it. */
export function stackOrder(blocks: Block[]): Block[] {
  const sec = (b: Block) => (b.type === 'section' ? 0 : 1)
  return [...blocks].sort((a, b) => a.y - b.y || sec(a) - sec(b) || a.x - b.x)
}

/** The topmost section whose area holds `b`'s center (the section it sits on), if any. */
export function sectionOf(b: Block, sections: Block[]): Block | undefined {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2
  return [...sections].reverse().find((s) => cx >= s.x && cx <= s.x + s.w && cy >= s.y && cy <= s.y + s.h)
}
