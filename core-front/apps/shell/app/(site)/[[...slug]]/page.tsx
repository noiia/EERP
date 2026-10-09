import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { erpPath } from '@eerp/core-front'
import Box from '@mui/material/Box'
import Container from '@mui/material/Container'
import { getSitePage, serverPublicSource } from '@/website/public-api'
import { BlockView } from '@/website/blocks/BlockView'
import { pictureUrl } from '@/website/urls'
import { StackedGrid } from '@/website/blocks/StackedGrid'

type Props = { params: Promise<{ slug?: string[] }> }

// "/" → home (slug ""), "/<slug>" → page, "/<slug>/<id>" → page with a
// record id for its record_detail blocks.
async function resolve(params: Props['params']) {
  const { slug = [] } = await params
  if (slug.length > 2) return null
  const page = await getSitePage(slug[0] ?? '')
  // No published home page (e.g. right after upgrading an ERP-only install): "/"
  // was the ERP, so send visitors there rather than to a 404.
  if (!page && slug.length === 0) redirect(erpPath('/'))
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
  const p = r.page
  return (
    // The page's background picture, if any; parallax keeps it fixed while the page scrolls.
    <Box sx={p.background ? {
      minHeight: '100%', backgroundImage: `url("${pictureUrl('website_page', p.id, 'background')}")`,
      backgroundSize: 'cover', backgroundPosition: 'center', backgroundAttachment: p.background_parallax ? 'fixed' : 'scroll',
    } : undefined}>
      <Container maxWidth="lg" sx={{ py: 4 }}>
        <StackedGrid blocks={p.layout} render={(b) => rendered.get(b.id)} />
      </Container>
    </Box>
  )
}
