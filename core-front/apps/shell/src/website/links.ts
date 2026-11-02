import { safeHref, safeNext } from './urls'

/** Built-in visitor pages a link can point at. */
export const SYSTEM_PAGES = { login: '/login', signup: '/signup', account: '/account' } as const

export type LinkKind = 'none' | 'page' | 'login' | 'signup' | 'account' | 'external'

/** The final URL of a stored link. `href` is `/<slug>`, a system page or an external URL;
 * `next` is the bare slug of the page Login/Sign up return to ('' = the default, /account).
 * An unsafe `next` is dropped, never forwarded. Unsafe `href` → undefined. */
export function linkHref(href: string | undefined, next?: string): string | undefined {
  const base = safeHref(href)
  if (!base) return undefined
  if ((base === SYSTEM_PAGES.login || base === SYSTEM_PAGES.signup) && next) {
    const path = next.startsWith('/') ? next : `/${next}`
    const ok = safeNext(path, '')
    if (ok) return `${base}?next=${encodeURIComponent(ok)}`
  }
  return base
}

/** The picker kind a stored href stands for: `/<slug>` of a known page → page, a system
 * page → itself, anything else (including a slug matching no page) → external. */
export function kindOf(href: string, pages: { slug: string }[]): LinkKind {
  if (!href) return 'none'
  if (href === SYSTEM_PAGES.login) return 'login'
  if (href === SYSTEM_PAGES.signup) return 'signup'
  if (href === SYSTEM_PAGES.account) return 'account'
  if (pages.some((p) => `/${p.slug}` === href)) return 'page'
  return 'external'
}
