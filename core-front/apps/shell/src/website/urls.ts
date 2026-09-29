const seg = encodeURIComponent

/** Browser-relative: the gateway routes /api/v1/* to Go, and public pictures need no session. */
export function pictureUrl(table: string, record: string, field: string): string {
  return `/api/v1/public/${seg(table)}/${seg(record)}/picture/${seg(field)}`
}

/** Block config is editor-authored: only relative paths, http(s) and mailto may become a link.
 * Whitespace/control chars and backslashes are refused outright — browsers strip or
 * normalize them ("/\\evil.com", "/<TAB>/evil.com" become protocol-relative URLs). */
export function safeHref(url: string | undefined): string | undefined {
  if (!url || /[\x00-\x20\\]/.test(url)) return undefined
  if (/^\/(?![/\\])/.test(url) || url === '/') return url
  return /^(https?:\/\/|mailto:)[^\s\\]+$/i.test(url) ? url : undefined
}
