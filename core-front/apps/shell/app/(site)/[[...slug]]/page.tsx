import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Container from '@mui/material/Container'
import { getSitePage, serverPublicSource } from '@/website/public-api'
import { BlockView } from '@/website/blocks/BlockView'
import { StackedGrid } from '@/website/blocks/StackedGrid'

type Props = { params: Promise<{ slug?: string[] }> }

// "/" → home (slug ""), "/<slug>" → page, "/<slug>/<id>" → page with a
// record id for its record_detail blocks.
async function resolve(params: Props['params']) {
  const { slug = [] } = await params
  if (slug.length > 2) return null
  const page = await getSitePage(slug[0] ?? '')
  return page ? { page, id: slug[1] } : null
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const r = await resolve(params)
  return r ? { title: r.page.title, description: r.page.seo_description ?? undefined } : {}
}

export default async function SitePage({ params }: Props) {
  const r = await resolve(params)
  if (!r) notFound()
  const rendered = new Map(
    await Promise.all(
      r.page.layout.map(
        async (b) => [b.id, await BlockView({ block: b, source: serverPublicSource, params: { id: r.id } })] as const,
      ),
    ),
  )
  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      <StackedGrid blocks={r.page.layout} render={(b) => rendered.get(b.id)} />
    </Container>
  )
}
