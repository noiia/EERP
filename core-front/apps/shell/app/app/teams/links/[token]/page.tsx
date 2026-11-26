import { notFound } from 'next/navigation'
import { activeModuleNames } from '@/lib/module-state'
import { requireAuth } from '@/lib/session'
import { LinkDownload } from '@/teams/LinkDownload'

// A Teams file download link: sign in first, then download through the BFF.
export default async function LinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  await requireAuth(`/teams/links/${token}`)
  if (!(await activeModuleNames()).has('teams')) notFound()
  return <LinkDownload token={token} />
}
