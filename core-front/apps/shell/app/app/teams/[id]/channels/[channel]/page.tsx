import { notFound } from 'next/navigation'
import { activeModuleNames } from '@/lib/module-state'
import { requireAuth } from '@/lib/session'
import { TeamsWorkspace } from '@/teams/TeamsWorkspace'

export default async function TeamChannelPage({ params }: { params: Promise<{ id: string; channel: string }> }) {
  const { id, channel } = await params
  await requireAuth(`/teams/${id}/channels/${channel}`)
  if (!(await activeModuleNames()).has('teams')) notFound()
  return <TeamsWorkspace teamId={id} view={{ kind: 'channel', id: channel }} />
}
