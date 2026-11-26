'use client'
import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams, useSelectedLayoutSegments } from 'next/navigation'
import type { WorkspaceView } from './Sidebar'
import { TeamsWorkspace } from './TeamsWorkspace'

/** The workspace a /teams/… URL shows (segments below /teams), or null for the dashboard. */
export function routeOf(segments: string[], folder?: string): { teamId?: string; view: WorkspaceView } | null {
  const [a, b, c] = segments.filter((s) => !s.startsWith('__'))
  if (a === undefined || a === 'links') return null // the dashboard, or a download link's own page
  if (a === 'shared') return { view: { kind: 'shared' } }
  if (a === 'direct') return { view: { kind: 'direct', id: b } }
  if (b === 'files') return { teamId: a, view: { kind: 'files', id: folder } }
  return { teamId: a, view: { kind: 'channel', id: b === 'channels' ? c : undefined } }
}

/** Held by the /teams layout, so moving between conversations keeps the workspace (and its
 * sidebar) mounted: only the conversation remounts. The pages do the server checks and render nothing.
 * The last team opened stays in the sidebar on Direct messages and Shares. */
export function TeamsShell({ children }: { children: ReactNode }) {
  const route = routeOf(useSelectedLayoutSegments(), useSearchParams().get('folder') ?? undefined)
  const [lastTeam, setLastTeam] = useState<string | undefined>()
  const routeTeam = route?.teamId
  const onDashboard = route === null
  useEffect(() => {
    if (routeTeam) setLastTeam(routeTeam)
    else if (onDashboard) setLastTeam(undefined)
  }, [routeTeam, onDashboard])
  if (!route) return children
  return (
    <>
      <TeamsWorkspace teamId={route.teamId ?? lastTeam} view={route.view} />
      {/* a page's not-found */}
      {children}
    </>
  )
}
