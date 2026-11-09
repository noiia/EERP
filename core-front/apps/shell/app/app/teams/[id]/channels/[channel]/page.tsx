import { notFound } from 'next/navigation'
import { apiRequest } from '@eerp/core-front/server'
import { activeModuleNames } from '@/lib/module-state'
import { requireAuth } from '@/lib/session'
import type { Channel } from '@/teams/client'
import { TeamsWorkspace } from '@/teams/TeamsWorkspace'

// A non-member (Go's 404) or a channel no longer in the team is a 404.
export default async function TeamChannelPage({ params }: { params: Promise<{ id: string; channel: string }> }) {
  const { id, channel } = await params
  await requireAuth(`/teams/${id}/channels/${channel}`)
  if (!(await activeModuleNames()).has('teams')) notFound()
  const channels = await apiRequest<{ data: Channel[] }>('GET', `/teams/${encodeURIComponent(id)}/channels`).then((r) => r.data, () => null)
  if (!channels?.some((c) => c.id === channel)) notFound()
  return <TeamsWorkspace teamId={id} view={{ kind: 'channel', id: channel }} />
}
