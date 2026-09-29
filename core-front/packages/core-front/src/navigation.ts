/** Where the ERP lives once the public website owns `/` (website spec 2).
 * Module route paths, descriptors and formPaths stay module-relative
 * ('/crm/:id'); erpPath() is applied ONLY where a link is emitted. */
export const ERP_BASE = '/app'

/** Prefix an ERP path with ERP_BASE. Idempotent; keeps query and hash. */
export function erpPath(path: string): string {
  if (
    path === ERP_BASE ||
    path.startsWith(ERP_BASE + '/') ||
    path.startsWith(ERP_BASE + '?') ||
    path.startsWith(ERP_BASE + '#')
  ) {
    return path
  }
  if (path === '/' || path === '') return ERP_BASE
  return ERP_BASE + (path.startsWith('/') ? path : '/' + path)
}
