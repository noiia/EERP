import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Container from '@mui/material/Container'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { T } from '@eerp/core-front'
import { presentFields } from '@/website/present'
import { serverPublicSource } from '@/website/public-api'
import { MIN_QUERY, searchRecords } from '@/website/search'
import { loadSearchBlock, publicSearchList } from '@/website/search-server'
import { RecordList } from '@/website/blocks/RecordList'
import { SearchBlock } from '@/website/blocks/SearchBlock'
import type { RecordListConfig } from '@/website/types'

export const metadata: Metadata = { title: 'Search', robots: { index: false } }

/** Rows per table on this page: the public API's page cap. */
const PAGE_ROWS = 100

type Props = { searchParams: Promise<{ q?: string; page?: string; block?: string }> }

/** /search?q=&page=&block= — every result of a website search block, opened by Enter in
 * the bar without picking a suggestion: one record list per searched table, in the
 * block's order. The tables come from the published page's block (never the URL, which
 * only names it); a missing page or block is a 404. */
export default async function SearchPage({ searchParams }: Props) {
  const { q = '', page = '', block = '' } = await searchParams
  const config = page && block ? await loadSearchBlock(page, block) : null
  if (!config) notFound()
  const text = q.trim()
  const groups = await searchRecords(config, text, await publicSearchList(), PAGE_ROWS)
  const lists = await Promise.all(groups.map(async ({ target: t, label, records }) => {
    const list: RecordListConfig = {
      table: t.table, title_field: t.title_field, fields: [], display: 'list', page_size: 10,
      detail_slug: t.detail_slug || undefined, picture_field: t.picture_field || undefined,
    }
    const presented = await presentFields({ table: t.table, fields: [], skip: t.title_field, records, source: serverPublicSource })
    return { key: t.table, label, list, records, presented }
  }))

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <Stack spacing={4}>
        <Stack spacing={2}>
          <Typography variant="h3" component="h1"><T text="Search results" /></Typography>
          <SearchBlock config={config} pageId={page} blockId={block} initialText={text} />
        </Stack>
        {text.length < MIN_QUERY
          ? <Typography color="text.secondary"><T text="Type at least 2 characters" /></Typography>
          : lists.length === 0
            ? <Typography color="text.secondary"><T text="No results" /></Typography>
            : lists.map((g) => (
              <Stack key={g.key} component="section" spacing={1} aria-label={g.label}>
                <Typography variant="h5" component="h2">{g.label} ({g.records.length})</Typography>
                <RecordList config={g.list} records={g.records} presented={g.presented} h={24} />
              </Stack>
            ))}
      </Stack>
    </Container>
  )
}
