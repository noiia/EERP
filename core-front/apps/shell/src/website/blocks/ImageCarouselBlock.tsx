import { pictureUrl } from '../urls'
import type { ImageCarouselConfig, PublicDataSource } from '../types'
import { hasPicture } from './fields'
import { ImageCarousel } from './ImageCarousel'

/** The pictures of hand-picked records (in order) or the table's first ones, capped at
 * `limit`; records without a picture drop out. Each links to its detail page when set. */
export async function ImageCarouselBlock({ config, source }: { config: ImageCarouselConfig; source: PublicDataSource }) {
  if (!config.table || !config.picture_field) return null
  const limit = Math.min(Math.max(config.limit ?? 10, 1), 100)
  let records: Record<string, unknown>[]
  if (config.records?.length) {
    const got = await Promise.all(config.records.slice(0, limit).map((id) => source.get(config.table, id)))
    records = got.filter((r): r is Record<string, unknown> => r != null)
  } else {
    records = (await source.list(config.table, { filter: config.filter, page_size: limit }))?.records ?? []
  }
  const images = records.filter((r) => hasPicture(r, config.picture_field)).map((r) => ({
    src: pictureUrl(config.table, String(r.id), config.picture_field),
    alt: config.title_field ? String(r[config.title_field] ?? '') : '',
    href: config.detail_slug ? `/${encodeURIComponent(config.detail_slug)}/${encodeURIComponent(String(r.id))}` : undefined,
  }))
  return <ImageCarousel images={images} />
}
