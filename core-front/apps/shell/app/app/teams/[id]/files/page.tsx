import { notFound } from 'next/navigation'
import { activeModuleNames } from '@/lib/module-state'
import { requireAuth } from '@/lib/session'
import { TeamsWorkspace } from '@/teams/TeamsWorkspace'

export default async function TeamFilesPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ folder?: string }> }) {
  const { id } = await params
  const { folder } = await searchParams
  await requireAuth(`/teams/${id}/files`)
  if (!(await activeModuleNames()).has('teams')) notFound()
  return <TeamsWorkspace teamId={id} view={{ kind: 'files', id: folder }} />
}
