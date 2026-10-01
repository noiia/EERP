import type { PublicDataSource, RecordDetailConfig } from '../types'
import { RecordDetailView } from './RecordDetailView'

/** The record plus, when `related` is set, its rows in that table (`link_field` = the
 * record's id) — e.g. a product's variants, picked by the visitor. */
export async function RecordDetailBlock({ config, source, id }: { config: RecordDetailConfig; source: PublicDataSource; id?: string }) {
  if (!id) return null
  const rec = await source.get(config.table, id)
  if (!rec) return null
  const rel = config.related
  const related = rel?.table && rel.link_field
    ? (await source.list(rel.table, { filter: { [rel.link_field]: id }, page_size: 100 }))?.records ?? []
    : []
  return <RecordDetailView config={config} rec={rec} related={related} />
}
