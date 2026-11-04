import { presentFields, siteFormatContext } from '../present'
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
  const ctx = await siteFormatContext()
  const [shown, relatedShown] = await Promise.all([
    presentFields({ table: config.table, fields: config.fields, skip: config.title_field, records: [rec], displays: config.field_display, source, ctx }),
    rel?.table ? presentFields({ table: rel.table, fields: rel.fields ?? [], skip: rel.title_field, records: related, displays: rel.field_display, source, ctx }) : null,
  ])
  return <RecordDetailView config={config} rec={rec} related={related} shown={shown} relatedShown={relatedShown} />
}
