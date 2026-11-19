import type { PublicDataSource } from './types'
import { hasPicture } from './blocks/fields'

/** The records a picture block shows: the hand-picked ones (in order) or the table's
 * first ones, capped at `limit`, keeping only those holding a picture on `field`.
 * Unpicked + a flag column (the key is in the record): only flagged rows are listed,
 * so a big table whose first rows have no picture still fills the block. */
export async function recordsWithPicture(source: PublicDataSource, q: {
  table: string; field: string; records?: string[]; limit: number; filter?: Record<string, string>
}): Promise<Record<string, unknown>[]> {
  let records: Record<string, unknown>[]
  if (q.records?.length) {
    const got = await Promise.all(q.records.slice(0, q.limit).map((id) => source.get(q.table, id)))
    records = got.filter((r): r is Record<string, unknown> => r != null) // unpublished/deleted ones drop out
  } else {
    records = (await source.list(q.table, { filter: q.filter, page_size: q.limit }))?.records ?? []
    if (records.length > 0 && q.field in records[0] && !records.every((r) => hasPicture(r, q.field))) {
      records = (await source.list(q.table, { filter: { ...q.filter, [q.field]: 'true' }, page_size: q.limit }))?.records ?? []
    }
  }
  return records.filter((r) => hasPicture(r, q.field))
}
