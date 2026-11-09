import { notFound, redirect } from 'next/navigation'
import { apiRequest, erpPath } from '@eerp/core-front/server'
import { activeModuleNames } from '@/lib/module-state'
import { requireAuth } from '@/lib/session'
import type { DirectChat } from '@/teams/client'
import { TeamsWorkspace } from '@/teams/TeamsWorkspace'

// Direct messages: the most recent conversation (Go lists them newest first), else the empty workspace.
export default async function DirectPage() {
  await requireAuth('/teams/direct')
  if (!(await activeModuleNames()).has('teams')) notFound()
  const chats = await apiRequest<{ data: DirectChat[] }>('GET', '/teams/direct').then((r) => r.data, () => [])
  if (chats.length > 0) redirect(erpPath(`/teams/direct/${chats[0].id}`))
  return <TeamsWorkspace view={{ kind: 'direct' }} />
}
