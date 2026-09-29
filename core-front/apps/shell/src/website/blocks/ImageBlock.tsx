import { pictureUrl, safeHref } from '../urls'
import type { ImageConfig } from '../types'

export function ImageBlock({ config }: { config: ImageConfig }) {
  const img = <img src={pictureUrl(config.table, config.record, config.field)} alt={config.alt} loading="lazy" style={{ maxWidth: '100%', height: 'auto' }} />
  const href = safeHref(config.href)
  return href ? <a href={href}>{img}</a> : img
}
