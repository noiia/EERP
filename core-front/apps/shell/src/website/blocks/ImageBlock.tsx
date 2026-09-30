import { pictureUrl, safeHref } from '../urls'
import type { ImageConfig } from '../types'

export function ImageBlock({ config }: { config: ImageConfig }) {
  // A freshly added block has no anchor yet: requesting /public///picture/ would 404.
  if (!config.table || !config.record || !config.field) return null
  const img = <img src={pictureUrl(config.table, config.record, config.field)} alt={config.alt} loading="lazy" style={{ maxWidth: '100%', height: 'auto' }} />
  const href = safeHref(config.href)
  return href ? <a href={href}>{img}</a> : img
}
