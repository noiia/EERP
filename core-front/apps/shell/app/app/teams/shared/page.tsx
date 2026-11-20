import { notFound } from 'next/navigation'
import { activeModuleNames } from '@/lib/module-state'
import { requireAuth } from '@/lib/session'

export default async function SharedPage() {
  await requireAuth('/teams/shared')
  if (!(await activeModuleNames()).has('teams')) notFound()
  return null // the layout's TeamsShell draws the workspace
}
