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
// master-key database manager, Next's own assets, and the per-host crawler/security
// files (robots.txt answers per host, so it must not redirect to the site host).
const ROOT_PASSTHROUGH = new Set([
  'app',
  'api',
  'print',
  'database',
  '_next',
  'favicon.ico',
  'robots.txt',
  'security.txt',
  '.well-known',
])

/** Pure routing decision for proxy.ts (website spec 2).
 *
 * Host mode splits the site (site_host) from the ERP (erp_host): an ERP path on the
 * site host, or a site path on the ERP host, is sent to the other host. The ERP stays
 * under /app on erp_host too (/ redirects there), so /app/... URLs are identical on
 * both hosts. Any other host (IP, localhost, internal name) gets path mode, so an
 * admin is never locked out by a wrong host setting.
 *
 * A published site page whose slug equals an ERP root (e.g. "contacts") wins over the
 * legacy bare-ERP-path redirect: `siteSlugs` is the set of published slugs. */
export function routeDecision(input: {
  pathname: string
  host: string
  erpRoots: ReadonlySet<string>
  siteSlugs: ReadonlySet<string>
  routing: Routing
}): RouteDecision {
  const first = input.pathname.split('/')[1] ?? ''
  const isErpPath = first === 'app' || (input.erpRoots.has(first) && !input.siteSlugs.has(first))
  const r = input.routing
  if (r.mode === 'host' && r.site_host && r.erp_host) {
    const host = input.host.replace(/:\d+$/, '').toLowerCase()
    if (host === r.site_host.toLowerCase() && isErpPath) {
      const p = first === 'app' ? input.pathname : '/app' + input.pathname
      return { kind: 'redirect', location: `https://${r.erp_host}${p}` }
    }
    if (host === r.erp_host.toLowerCase()) {
      if (input.pathname === '/') return { kind: 'redirect', location: '/app' }
      if (!ROOT_PASSTHROUGH.has(first) && !isErpPath) {
        return { kind: 'redirect', location: `https://${r.site_host}${input.pathname}` }
      }
      return { kind: 'next' }
    }
    // Any other host falls through to path mode.
  }
  if (ROOT_PASSTHROUGH.has(first)) return { kind: 'next' }
  // A bare ERP path (pre-/app bookmark, or a link a module still emits raw).
  if (isErpPath) return { kind: 'redirect', location: ERP_BASE + input.pathname }
  return { kind: 'next' }
}
