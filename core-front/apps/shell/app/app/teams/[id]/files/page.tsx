import { notFound } from 'next/navigation'
import { apiRequest } from '@eerp/core-front/server'
import { activeModuleNames } from '@/lib/module-state'
import { requireAuth } from '@/lib/session'
import { TeamsWorkspace } from '@/teams/TeamsWorkspace'

// A non-member gets Go's 404 on the team itself.
export default async function TeamFilesPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ folder?: string }> }) {
  const { id } = await params
  const { folder } = await searchParams
  await requireAuth(`/teams/${id}/files`)
  if (!(await activeModuleNames()).has('teams')) notFound()
  if (!(await apiRequest('GET', `/teams/${encodeURIComponent(id)}`).then(() => true, () => false))) notFound()
  return <TeamsWorkspace teamId={id} view={{ kind: 'files', id: folder }} />
}
