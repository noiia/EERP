import { notFound } from 'next/navigation'
import { activeModuleNames } from '@/lib/module-state'
import { requireAuth } from '@/lib/session'
import { TeamsWorkspace } from '@/teams/TeamsWorkspace'

export default async function DirectChannelPage({ params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params
  await requireAuth(`/teams/direct/${channel}`)
  if (!(await activeModuleNames()).has('teams')) notFound()
  return <TeamsWorkspace view={{ kind: 'direct', id: channel }} />
}
