import { NextResponse, type NextRequest } from 'next/server'
import {
  ACCESS_COOKIE,
  ApiError,
  REFRESH_COOKIE,
  REFRESH_TTL_SECONDS,
  moduleRegistry,
  sessionCookieOptions,
} from '@eerp/core-front/server'
// Side-effect import: registers every discovered module, so erpRoots below knows
// every module route's first segment.
import '@/generated/generated-modules'
import { goAuthExchange, type AuthBase } from '@/lib/bff'
import { routeDecision, type Routing } from '@/lib/routing'
import { SITE_ACCESS_COOKIE, SITE_REFRESH_COOKIE } from '@/lib/site-session'

// Proactively rotates the sessions (the ERP one and the website visitor one) ahead of every request, so by the time a Server
// Component renders, the access cookie is already fresh. This is the one place
// upstream of RSC render that both runs on every request and can legally write
// cookies (Next forbids `cookies().set()` during a Server Component render — see
// ApiClient.ts). It also restores "stay logged in for the refresh token's 7-day
// lifetime" — without it, the access cookie's 1h expiry silently drops a live
// session to anonymous until something reactively refreshes it.
//
// The access cookie's maxAge is set to match the access token's own TTL
// (ACCESS_TTL_SECONDS), so the browser dropping the cookie IS the "expired" signal —
// no JWT decoding needed here.

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/auth|api/site-auth).*)'],
}

// First path segment of every ERP page that used to live at the root (website
// spec 2 moved the ERP under /app): every registered module route plus the
// shell's own ERP sections. A bare hit on one (an old bookmark) 307s to /app/….
// Built once — the module set is compiled in.
const erpRoots: ReadonlySet<string> = new Set([
  ...[...moduleRegistry.buildRegistry().keys()]
    .map((path) => path.split('/')[1] ?? '')
    .filter((seg) => seg !== '' && !seg.startsWith(':')),
  'settings',
  'appstore',
  'force-password-change',
])

// Per-request CSP nonce (https://nextjs.org/docs/app/guides/content-security-policy):
// App Router streams hydration/RSC payloads via inline `<script>` tags it injects
// itself, which a strict `script-src 'self'` blocks outright — the resulting broken
// hydration is what makes a controlled MUI field's label (acting as the placeholder)
// never shrink on input, among other silent failures. Next only nonces its own
// inline scripts when it sees the nonce on the REQUEST headers flowing into the
// render, so this must happen in middleware, not in nginx after the fact — nginx
// can't know a nonce it never generated. This header is now the sole source of CSP
// for the frontend; infra/nginx/nginx.conf's own Content-Security-Policy add_header
// was removed so the two don't combine into a stricter, nonce-less intersection.
function cspHeaderValue(nonce: string): string {
  return `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`
}

function withCsp(response: NextResponse, nonce: string): NextResponse {
  response.headers.set('Content-Security-Policy', cspHeaderValue(nonce))
  return response
}

// The site routing (Go's website setting) and the published page slugs, fetched
// together and cached in-process for 60 s: a routing change takes effect within a
// minute without a Go round trip per request. A failed fetch (outage, 429, timeout)
// keeps the last good value — so a crawler draining Go's per-IP public bucket can't
// flip a host-mode site to path mode — and retries after the TTL; with no good value
// yet it degrades to path mode / no slugs.
// EERP_SITE_ROUTING=path forces path mode: the escape hatch for a wrong host setting.
const ROUTING_TTL_MS = 60_000
const ROUTING_TIMEOUT_MS = 2_000 // a hung Go must not hang every page load
type SiteRouting = { routing: Routing; slugs: ReadonlySet<string> }
const PATH_MODE: SiteRouting = { routing: { mode: 'path' }, slugs: new Set() }
// The in-flight promise is cached, so concurrent cold requests share one fetch. It
// never rejects: every failure resolves to the last good value.
let routingCache: { value: Promise<SiteRouting>; at: number } | null = null
let lastGood: SiteRouting = PATH_MODE

/** Test hook: forget the cached routing. */
export function resetRoutingCache(): void {
  routingCache = null
  lastGood = PATH_MODE
}

// Returns null on a 404 (e.g. website_page not published): a real answer, not a failure.
async function publicJSON<T>(path: string, ip: string | undefined): Promise<T | null> {
  const res = await fetch(`${process.env.API_BASE}/api/v${process.env.API_VERSION ?? '1'}/public/${path}`, {
    cache: 'no-store',
    // Go rate-limits /public per client IP; without it every visitor shares this server's bucket.
    headers: ip ? { 'X-Forwarded-For': ip } : {},
    signal: AbortSignal.timeout(ROUTING_TIMEOUT_MS),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`public ${path}: ${res.status}`)
  return (await res.json()) as T
}

async function fetchRouting(ip: string | undefined): Promise<SiteRouting> {
  const prev = lastGood
  const [routing, slugs] = await Promise.all([
    publicJSON<{ routing?: Routing }>('site', ip).then((b) => b?.routing ?? { mode: 'path' as const }, () => prev.routing),
    // ?distinct returns every slug (capped at Go's 500 distinct values) without the layouts.
    publicJSON<{ values?: { value?: unknown }[] }>('website_page?distinct=slug', ip).then(
      (b) => new Set((b?.values ?? []).map((v) => v.value).filter((x): x is string => typeof x === 'string' && x !== '')),
      () => prev.slugs,
    ),
  ])
  lastGood = { routing, slugs }
  return lastGood
}

async function currentRouting(ip: string | undefined): Promise<SiteRouting> {
  const now = Date.now()
  if (!routingCache || now - routingCache.at >= ROUTING_TTL_MS) {
    routingCache = { value: fetchRouting(ip), at: now }
  }
  const value = await routingCache.value
  return process.env.EERP_SITE_ROUTING === 'path' ? { ...value, routing: { mode: 'path' } } : value
}

/**
 * Rotates one session (ERP or website) when its access cookie is gone but its
 * refresh cookie remains. The fresh access cookie is also written into the request
 * cookies, so the render that follows sees it immediately. Returns what to apply
 * to the response. Only Go's 401 means the session is dead: a 429/5xx/outage keeps
 * the cookies (same rule as /api/site-auth/refresh) and the next request retries.
 */
async function refreshSession(
  request: NextRequest,
  s: { access: string; refresh: string; base: AuthBase },
  ip: string | undefined,
): Promise<(response: NextResponse) => void> {
  const refreshToken = request.cookies.get(s.refresh)?.value
  if (request.cookies.has(s.access) || !refreshToken) return () => {}
  try {
    const tokens = await goAuthExchange('refresh', { refresh_token: refreshToken }, s.base, { forwardedFor: ip })
    request.cookies.set(s.access, tokens.accessToken)
    return (response) => {
      response.cookies.set(s.access, tokens.accessToken, sessionCookieOptions(tokens.expiresIn))
      if (tokens.refreshToken) {
        response.cookies.set(s.refresh, tokens.refreshToken, sessionCookieOptions(REFRESH_TTL_SECONDS))
      }
    }
  } catch (e) {
    // Spent/invalid refresh token (theft detection) — clear the session so the
    // request renders anonymous instead of retrying every request.
    if (!(e instanceof ApiError && e.status === 401)) return () => {}
    return (response) => {
      response.cookies.delete(s.access)
      response.cookies.delete(s.refresh)
    }
  }
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const nonce = btoa(crypto.randomUUID())

  // Go rate-limits per client IP; forwarded on every Go call made from here.
  const ip = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? undefined
  const { routing, slugs } = await currentRouting(ip)
  // The gateway sets Host ($host); x-forwarded-host is client-controllable, so it is ignored.
  const host = request.headers.get('host') ?? request.nextUrl.host
  const decision = routeDecision({ pathname: request.nextUrl.pathname, host, erpRoots, siteSlugs: slugs, routing })
  if (decision.kind === 'redirect') {
    const target = new URL(decision.location, request.url)
    target.search = request.nextUrl.search
    // Always 307: every redirect depends on something that changes (the routing
    // setting, or — for a legacy bare-ERP path — the published-slug set), and a 308
    // would be cached by the browser forever.
    return withCsp(NextResponse.redirect(target, 307), nonce)
  }

  const apply = await Promise.all([
    refreshSession(request, { access: ACCESS_COOKIE, refresh: REFRESH_COOKIE, base: 'auth' }, ip),
    refreshSession(request, { access: SITE_ACCESS_COOKIE, refresh: SITE_REFRESH_COOKIE, base: 'website/auth' }, ip),
  ])

  // Built after the refreshes so the forwarded cookie header carries the fresh access tokens.
  const forwardedRequest = new Headers(request.headers)
  forwardedRequest.set('x-nonce', nonce)
  forwardedRequest.set('Content-Security-Policy', cspHeaderValue(nonce))
  const response = NextResponse.next({ request: { headers: forwardedRequest } })
  for (const f of apply) f(response)
  return withCsp(response, nonce)
}
