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
 * into the ERP ("/./app" and "/../app" normalise into it, so dot segments are refused
 * too); anything else is `fallback`. */
export function safeNext(n: string | undefined, fallback = '/account'): string {
  return n &&
    n.startsWith('/') &&
    safeHref(n) &&
    n.split(/[/?#]/)[1] !== 'app' &&
    !n.split(/[?#]/)[0].split('/').some((s) => s === '.' || s === '..')
    ? n
    : fallback
}
