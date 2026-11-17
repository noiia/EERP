import { notFound } from 'next/navigation'
import type { Identity } from '@eerp/core-front'
import { activeModuleNames } from '@/lib/module-state'
import { requireAuth } from '@/lib/session'

/**
 * Guard for the Project app's own shell pages (My day, Timesheet week,
 * Workload, Portfolio): require a session for `path`, then 404 while the
 * `project` module is inactive. Discovery compiles every module's routes
 * regardless of `active` (docs/roadmaps/app-store.md, live lifecycle), so the
 * page's own live Go-sourced active state is what blocks a deactivated module
 * here — the same gate the catch-all module page applies.
 *
 * Returns the resolved identity (the page may need the caller's user id).
 */
export async function requireProjectPage(path: string): Promise<Identity> {
  const identity = await requireAuth(path)
  if (!(await activeModuleNames()).has('project')) notFound()
  return identity
}
