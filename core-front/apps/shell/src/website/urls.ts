const seg = encodeURIComponent

/** Browser-relative: the gateway routes /api/v1/* to Go, and public pictures need no session. */
export function pictureUrl(table: string, record: string, field: string): string {
  return `/api/v1/public/${seg(table)}/${seg(record)}/picture/${seg(field)}`
}

/** Block config is editor-authored: only relative paths, http(s) and mailto may become a link. */
export function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined
  if (url.startsWith('/') && !url.startsWith('//')) return url
  return /^(https?|mailto):/i.test(url) ? url : undefined
}
