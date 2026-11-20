import { notFound } from 'next/navigation'
import { apiRequest } from '@eerp/core-front/server'
import { activeModuleNames } from '@/lib/module-state'
import { requireAuth } from '@/lib/session'

// A non-member gets Go's 404 on the team itself.
export default async function TeamFilesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireAuth(`/teams/${id}/files`)
  if (!(await activeModuleNames()).has('teams')) notFound()
  if (!(await apiRequest('GET', `/teams/${encodeURIComponent(id)}`).then(() => true, () => false))) notFound()
  return null // the layout's TeamsShell draws the workspace
}
