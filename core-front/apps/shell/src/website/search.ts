import type { Block, SearchConfig, SearchTarget } from './types'

// The search block's server half (pure, so it tests without Next): given the block's
// config — read from the stored, published page, never from the browser — run the
// visitor's text against every target table through Go's public list API. Go's
// `search[col]` is case-insensitive containment, and several `search[]` params AND
// together, so each searched column is its own request; their rows are merged by id.
// Go's public scope is the security boundary: an unpublished table 404s and a
// non-public column 400s, and either just leaves that table out of the results.

export const MIN_QUERY = 2
export const MAX_QUERY = 100
const MAX_TARGETS = 10

export interface SearchHit { id: string; title: string; href?: string; picture?: string }
export interface SearchGroup { table: string; label: string; hits: SearchHit[] }

/** GET of a public list path (`/<table>?…`): its rows, or null on any non-2xx. */
export type PublicList = (path: string) => Promise<Record<string, unknown>[] | null>

/** The search block `blockId` of a page layout, or null when there is none. */
export function findSearchBlock(layout: Block[] | null | undefined, blockId: string): SearchConfig | null {
  const b = (layout ?? []).find((x) => x.id === blockId && x.type === 'search')
  return b ? (b.config as unknown as SearchConfig) : null
}

export const clampLimit = (n: unknown) => Math.min(Math.max(Math.trunc(typeof n === 'number' && Number.isFinite(n) ? n : 5), 1), 20)

const seg = encodeURIComponent
const hasPicture = (rec: Record<string, unknown>, field?: string): field is string =>
  !!field && (rec[field] === undefined || rec[field] === true)

/** A target's matching rows: one request per searched column, merged by id, sorted by
 * title, at most `limit`. */
async function searchRows(t: SearchTarget, q: string, limit: number, list: PublicList): Promise<Record<string, unknown>[]> {
  const cols = [...new Set((t.search_fields?.length ? t.search_fields : [t.title_field]).filter(Boolean))]
  const pages = await Promise.all(cols.map((col) => {
    const p = new URLSearchParams({ page_size: String(limit), order: t.title_field })
    p.set(`search[${col}]`, q)
    return list(`/${seg(t.table)}?${p}`)
  }))
  const seen = new Map<string, Record<string, unknown>>()
  for (const rows of pages) for (const r of rows ?? []) if (typeof r.id === 'string' && !seen.has(r.id)) seen.set(r.id, r)
  const title = (r: Record<string, unknown>) => String(r[t.title_field] ?? '')
  return [...seen.values()].sort((a, b) => title(a).localeCompare(title(b))).slice(0, limit)
}

/** One searched table's rows, for the full results page. */
export interface SearchRecords { target: SearchTarget; label: string; records: Record<string, unknown>[] }

/** Runs `q` over the config's targets, in their order, `limit` rows each (default: the
 * block's own limit); tables with no hit are left out. */
export async function searchRecords(config: SearchConfig, q: string, list: PublicList, limit = clampLimit(config.limit)): Promise<SearchRecords[]> {
  const text = q.trim().slice(0, MAX_QUERY)
  if (text.length < MIN_QUERY) return []
  const targets = (config.targets ?? []).filter((t) => t?.table && t.title_field).slice(0, MAX_TARGETS)
  const groups = await Promise.all(targets.map(async (t) => ({
    target: t,
    label: t.label?.trim() || t.table,
    records: await searchRows(t, text, limit, list),
  })))
  return groups.filter((g) => g.records.length > 0)
}

/** The search bar's autocomplete: the block's own limit per table, as titled hits. */
export async function runSearch(config: SearchConfig, q: string, list: PublicList): Promise<SearchGroup[]> {
  return (await searchRecords(config, q, list)).map(({ target: t, label, records }) => ({
    table: t.table,
    label,
    hits: records.map((r) => {
      const id = r.id as string
      return {
        id,
        title: String(r[t.title_field] ?? ''),
        href: t.detail_slug ? `/${seg(t.detail_slug)}/${seg(id)}` : undefined,
        picture: hasPicture(r, t.picture_field) ? `/api/v1/public/${seg(t.table)}/${seg(id)}/picture/${seg(t.picture_field)}` : undefined,
      }
    }),
  }))
}

/** The full results page for a search block's text (Enter without picking a result). */
export const searchPageHref = (pageId: string, blockId: string, q: string) =>
  `/search?${new URLSearchParams({ q: q.trim(), page: pageId, block: blockId })}`
