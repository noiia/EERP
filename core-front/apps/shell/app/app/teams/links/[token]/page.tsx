import { notFound } from 'next/navigation'
import { apiRequest } from '@eerp/core-front/server'
import { activeModuleNames } from '@/lib/module-state'
import { requireAuth } from '@/lib/session'
import { LinkDownload, type LinkInfo } from '@/teams/LinkDownload'

// A Teams file download link: sign in first, then name the file (or say the link
// is dead) and download it through the BFF.
export default async function LinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  await requireAuth(`/teams/links/${token}`)
  if (!(await activeModuleNames()).has('teams')) notFound()
  const info = await apiRequest<LinkInfo>('GET', `/teams/links/${encodeURIComponent(token)}`).catch(() => null)
  return <LinkDownload token={token} info={info} />
}
