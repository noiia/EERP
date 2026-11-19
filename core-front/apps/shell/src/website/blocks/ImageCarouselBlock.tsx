import { recordsWithPicture } from '../pictures'
import { pictureUrl } from '../urls'
import type { ImageCarouselConfig, PublicDataSource } from '../types'
import { ImageCarousel } from './ImageCarousel'

/** The pictures of hand-picked records (in order) or the table's first ones holding a
 * picture, capped at `limit`. Each links to its detail page when set. */
export async function ImageCarouselBlock({ config, source }: { config: ImageCarouselConfig; source: PublicDataSource }) {
  if (!config.table || !config.picture_field) return null
  const limit = Math.min(Math.max(config.limit ?? 10, 1), 100)
  const records = await recordsWithPicture(source, { table: config.table, field: config.picture_field, records: config.records, limit, filter: config.filter })
  const images = records.map((r) => ({
    src: pictureUrl(config.table, String(r.id), config.picture_field),
    alt: config.title_field ? String(r[config.title_field] ?? '') : '',
    href: config.detail_slug ? `/${encodeURIComponent(config.detail_slug)}/${encodeURIComponent(String(r.id))}` : undefined,
  }))
  return <ImageCarousel images={images} fill />
}
