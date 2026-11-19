const seg = encodeURIComponent

/** Browser-relative: the gateway routes /api/v1/* to Go, and public pictures need no session. */
export function pictureUrl(table: string, record: string, field: string): string {
  return `/api/v1/public/${seg(table)}/${seg(record)}/picture/${seg(field)}`
}

/** Block config is editor-authored: only relative paths, http(s) and mailto may become a link.
 * Whitespace/control chars and backslashes are refused outright — browsers strip or
 * normalize them ("/\\evil.com", "/<TAB>/evil.com" become protocol-relative URLs). */
export function safeHref(url: string | undefined): string | undefined {
  // eslint-disable-next-line no-control-regex -- intentional: refuse control chars in hrefs
  if (!url || /[\x00-\x20\\]/.test(url)) return undefined
  if (/^\/(?![/\\])/.test(url) || url === '/') return url
  return /^(https?:\/\/|mailto:)[^\s\\]+$/i.test(url) ? url : undefined
}

/** A `?next=` destination: same-site relative paths only (safeHref refuses control chars,
 * whitespace and backslashes the URL parser would strip into "//evil.example"), never
 * into the ERP. The path is normalised first, so "/./app", "/../app" and their
 * percent-encoded forms ("/%2e%2e/app") are judged by where they land; any dot segment,
 * raw or encoded, is refused outright. Anything else is `fallback`. The original string
 * is returned, not the normalised one. */
export function safeNext(n: string | undefined, fallback = '/account'): string {
  if (!n || !n.startsWith('/') || !safeHref(n)) return fallback
  const raw = n.split(/[?#]/)[0].split('/')
  if (raw.some((s) => /^(\.|%2e){1,2}$/i.test(s)) || /%(2f|5c)/i.test(n.split(/[?#]/)[0])) return fallback
  let url: URL
  try {
    url = new URL(n, 'http://x')
  } catch {
    return fallback
  }
  let first: string
  try {
    first = decodeURIComponent(url.pathname.split('/')[1] ?? '')
  } catch {
    return fallback
  }
  if (url.origin !== 'http://x' || first.toLowerCase() === 'app' || url.pathname.includes('//')) return fallback
  return n
}
