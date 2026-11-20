import type { ReactNode } from 'react'
import { TeamsShell } from '@/teams/TeamsShell'

export default function TeamsLayout({ children }: { children: ReactNode }) {
  return <TeamsShell>{children}</TeamsShell>
}
