import 'server-only'

/** Relays Go's OAuth discovery documents (ADR-043) to the site-root
 * /.well-known/* URLs MCP clients read: same status and JSON, readable from any
 * origin (they are public), not cached for long so a config change shows. */
export async function relayOAuthMetadata(kind: 'authorization-server' | 'protected-resource'): Promise<Response> {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  try {
    const res = await fetch(`${process.env.API_BASE}/api/v${process.env.API_VERSION ?? '1'}/oauth/metadata/${kind}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    })
    return new Response(res.ok ? await res.text() : '{"error":"not_found"}', {
      status: res.ok ? 200 : 404,
      headers: { ...headers, 'Cache-Control': res.ok ? 'public, max-age=300' : 'no-store' },
    })
  } catch {
    return new Response('{"error":"unavailable"}', { status: 503, headers: { ...headers, 'Cache-Control': 'no-store' } })
  }
}
