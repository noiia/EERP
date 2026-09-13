import { create } from 'zustand'

// The shell's top-bar breadcrumb is a running trail of the PAGES THE USER
// ACTUALLY VISITED, in order — never an ancestor chain inferred from the
// current URL's own path segments. The host (AppTopBar's PathBreadcrumbs)
// computes ONLY the current pathname's own single crumb (crumbForPath — no
// sibling-list lookahead, no per-segment ancestor synthesis) and feeds it
// through `visit` on every pathname change. This is what makes a record
// reached WITHOUT visiting its list first (e.g. clicking a row inside an
// unrelated record's embedded relation grid) show just that record's own
// crumb — never a "List" ancestor the user never actually passed through —
// while a record reached BY WAY of its list still shows both, because the
// list's own crumb already landed in the trail from that real visit.
//
// Session-only (no persistence — a stale trail from a previous session/
// tenant is more confusing than a trail that starts fresh on reload, and
// nothing here is business data).

export interface Crumb {
  label: string
  href: string
}

/**
 * Pure trail-transition function — exported for testing independent of the
 * store/React. `current` is the pathname just navigated to, as ONE crumb
 * (crumbForPath's output), or `null` on the menu root (resets the trail).
 */
export function nextBreadcrumbTrail(trail: Crumb[], current: Crumb | null): Crumb[] {
  if (!current) return []

  // Already-visited exact page (a plain <Link>, browser back/forward, or a
  // breadcrumb click landing here) — go back to it, dropping anything after.
  // REPLACES the matched entry with the fresh incoming one rather than
  // keeping the stored copy: a record's own crumb is first visited before
  // its real name resolves (record-label-store reports it asynchronously,
  // shortly after the form mounts), so the label can legitimately improve
  // on a later visit to the SAME href.
  const idx = trail.findIndex((c) => c.href === current.href)
  if (idx !== -1) return [...trail.slice(0, idx), current]

  // A genuinely new page: append it as the newest visited view.
  return [...trail, current]
}

export interface BreadcrumbState {
  trail: Crumb[]
  /** Feed the current pathname's own single crumb into the trail — also how
   * a breadcrumb click's navigation ends up truncating the trail (the
   * clicked href is already IN the trail, so `nextBreadcrumbTrail` returns
   * the slice up to it) and how landing back on "/" resets it (`null`). */
  visit: (current: Crumb | null) => void
}

export const useBreadcrumbStore = create<BreadcrumbState>((set) => ({
  trail: [],
  visit: (current) => set((s) => ({ trail: nextBreadcrumbTrail(s.trail, current) })),
}))
