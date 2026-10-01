import type { PublicDataSource, RecordListConfig } from '../types'
import { RecordList } from './RecordList'

/** Fetches the records once; the visitor's view/page-size/page choices are client-side.
 * ponytail: capped at the public API's 100-row page; page server-side past that if tables grow. */
export async function RecordListBlock({ config, source, h }: { config: RecordListConfig; source: PublicDataSource; h: number }) {
  const res = await source.list(config.table, { filter: config.filter, page_size: 100 })
  if (!res) return null
  return <RecordList config={config} records={res.records} h={h} />
}
