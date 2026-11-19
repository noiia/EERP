import { notFound, redirect } from 'next/navigation'
import { apiRequest, erpPath } from '@eerp/core-front/server'
import { activeModuleNames } from '@/lib/module-state'
import { requireAuth } from '@/lib/session'
import type { Channel } from '@/teams/client'
import { TeamsWorkspace } from '@/teams/TeamsWorkspace'

// A team's entry: its first channel. A non-member gets Go's 404.
export default async function TeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireAuth(`/teams/${id}`)
  if (!(await activeModuleNames()).has('teams')) notFound()
  const channels = await apiRequest<{ data: Channel[] }>('GET', `/teams/${encodeURIComponent(id)}/channels`).then((r) => r.data, () => null)
  if (!channels) notFound()
  if (channels.length > 0) redirect(erpPath(`/teams/${id}/channels/${channels[0].id}`))
  return <TeamsWorkspace teamId={id} view={{ kind: 'channel' }} />
}
