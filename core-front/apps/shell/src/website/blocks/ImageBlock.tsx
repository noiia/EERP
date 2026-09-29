import { pictureUrl } from '../public-api'
import type { ImageConfig } from '../types'

export function ImageBlock({ config }: { config: ImageConfig }) {
  const img = <img src={pictureUrl(config.table, config.record, config.field)} alt={config.alt} loading="lazy" style={{ maxWidth: '100%', height: 'auto' }} />
  return config.href ? <a href={config.href}>{img}</a> : img
}
