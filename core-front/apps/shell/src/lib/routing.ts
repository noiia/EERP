import { ERP_BASE } from '@eerp/core-front/server'

/** Mirrors Go's website routing setting (website spec 2). */
export interface Routing {
  mode: 'path' | 'host'
  site_host?: string
  erp_host?: string
}

export type RouteDecision = { kind: 'next' } | { kind: 'redirect'; location: string }

// First path segments that are never a legacy ERP path: the ERP itself, the BFF,
// report print targets (pdf-service renders frontend_base_url + /print/...), the
// master-key database manager, and Next's own assets.
const ROOT_PASSTHROUGH = new Set(['app', 'api', 'print', 'database', '_next', 'favicon.ico'])

/** Pure routing decision for proxy.ts (website spec 2). Path mode only for now;
 * host mode lands with the site session (Task 9). */
export function routeDecision(input: {
  pathname: string
  host: string
  erpRoots: ReadonlySet<string>
  routing: Routing
}): RouteDecision {
  const first = input.pathname.split('/')[1] ?? ''
  if (ROOT_PASSTHROUGH.has(first)) return { kind: 'next' }
  // A bare ERP path (pre-/app bookmark, or a link a module still emits raw).
  if (input.erpRoots.has(first)) return { kind: 'redirect', location: ERP_BASE + input.pathname }
  return { kind: 'next' }
}
