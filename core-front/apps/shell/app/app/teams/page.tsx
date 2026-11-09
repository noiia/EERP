import { notFound } from 'next/navigation'
import { activeModuleNames } from '@/lib/module-state'
import { requireAuth } from '@/lib/session'
import { TeamsDashboard } from '@/teams/TeamsDashboard'

// Teams app landing: the caller's teams plus the direct-messages entry.
export default async function TeamsPage() {
  await requireAuth('/teams')
  if (!(await activeModuleNames()).has('teams')) notFound()
  return <TeamsDashboard />
}
