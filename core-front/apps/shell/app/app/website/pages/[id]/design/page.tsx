import { notFound } from 'next/navigation'
import { ApiError, createServerApiClient } from '@eerp/core-front/server'
import { activeModuleNames } from '@/lib/module-state'
import { requireAuth } from '@/lib/session'
import { getPublished } from '@/lib/website-settings'
import { saveLayout } from '@/website/editor-actions'
import type { Block } from '@/website/types'
import { PageEditor } from './PageEditor'

type PageRecord = { id: string; slug: string; title: string; layout: Block[] | null; background?: boolean | null; background_parallax?: boolean | null }

export default async function DesignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireAuth(`/website/pages/${id}/design`)
  if (!(await activeModuleNames()).has('website')) notFound()
  let page: PageRecord
  try {
    page = await createServerApiClient().get<PageRecord>('website_page', id)
  } catch (e) {
    if (e instanceof ApiError && (e.status === 400 || e.status === 404)) notFound() // 400: not a uuid
    throw e
  }
  return (
    <PageEditor
      pageId={id}
      slug={page.slug}
      title={page.title}
      layout={page.layout ?? []}
      background={{ on: !!page.background, parallax: !!page.background_parallax }}
      published={await getPublished()}
      save={saveLayout.bind(null, id)}
    />
  )
}
