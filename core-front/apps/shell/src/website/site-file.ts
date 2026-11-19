import 'server-only'

/** Relays one of Go's public text files (robots.txt, security.txt) as the
 * response of a site-root route: same status, plain text, cached 5 minutes. */
export async function relaySiteFile(
  request: Request,
  name: 'robots.txt' | 'security.txt',
): Promise<Response> {
  // Go answers robots.txt per host (the ERP host is closed to crawlers).
  const host = request.headers.get('host') ?? ''
  const q = name === 'robots.txt' ? `?host=${encodeURIComponent(host)}` : ''
  const ip = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip')
  try {
    const res = await fetch(
      `${process.env.API_BASE}/api/v${process.env.API_VERSION ?? '1'}/public/${name}${q}`,
      {
        cache: 'no-store',
        headers: ip ? { 'X-Forwarded-For': ip } : {},
        signal: AbortSignal.timeout(5_000),
      },
    )
    const body = res.ok ? await res.text() : ''
    return new Response(body || (res.status === 404 ? 'Not found\n' : ''), {
      status: res.ok ? 200 : res.status,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': res.ok ? 'public, max-age=300' : 'no-store',
      },
    })
  } catch {
    return new Response('', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }
}
