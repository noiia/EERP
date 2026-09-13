import { create } from 'zustand'

// The shell's top-bar breadcrumb used to be PURELY derived from the current
// pathname (one segment = one crumb) — correct for a single nested route
// tree, but it forgets everything the moment the user jumps to an unrelated
// section (e.g. Sale's own "Configuration" menu into /settings/apps/sale):
// the old trail would just be replaced by the new path's own segments, so
// there was no way back to where the user actually came from.
//
// This store instead keeps a running trail across navigations, session-only
// (no persistence — a stale trail from a previous session/tenant is more
// confusing than a trail that starts fresh on reload, and nothing here is
// business data). The host (AppTopBar's PathBreadcrumbs) computes the
// CURRENT location's own local chain (crumbsFromPath — unchanged) on every
// pathname change and feeds it through `visit`, which decides whether that's
// "diving deeper in the same section" (replaces the trailing run belonging
// to that section) or "jumping to a new section" (appended after whatever
// came before) or "returning to a page already in the trail" (truncates
// forward history, same as clicking an ancestor crumb).

export interface Crumb {
  label: string
  href: string
}

/**
 * Pure trail-transition function — exported for testing independent of the
 * store/React. `localCrumbs` is the CURRENT pathname's own root-to-leaf chain
 * (crumbsFromPath's output: index 0 is always the top-level segment, e.g.
 * "/sale" or "/settings").
 */
export function nextBreadcrumbTrail(trail: Crumb[], localCrumbs: Crumb[]): Crumb[] {
  if (localCrumbs.length === 0) return []

  // Already-visited exact page (a plain <Link>, browser back/forward, or a
  // breadcrumb click landing here) — go back to it, dropping anything after.
  // REPLACES the matched entry with the fresh incoming one rather than
  // keeping the stored copy: a record's own crumb is first visited before
  // its real name resolves (record-label-store reports it asynchronously,
  // shortly after the form mounts), so the label can legitimately improve
  // on a later visit to the SAME href.
  const currentHref = localCrumbs[localCrumbs.length - 1].href
  const exactIdx = trail.findIndex((c) => c.href === currentHref)
  if (exactIdx !== -1) {
    return [...trail.slice(0, exactIdx), localCrumbs[localCrumbs.length - 1]]
  }

  // Same top-level section as somewhere already in the trail: the local
  // chain IS the authoritative root-to-leaf chain for that section, so it
  // replaces the trailing run belonging to it rather than duplicating the
  // section's root crumb.
  const sectionRoot = localCrumbs[0].href
  const sectionIdx = trail.findIndex((c) => c.href === sectionRoot)
  const base = sectionIdx !== -1 ? trail.slice(0, sectionIdx) : trail
  return [...base, ...localCrumbs]
}

export interface BreadcrumbState {
  trail: Crumb[]
  /** Feed the current pathname's own local crumb chain into the trail — also
   * how a breadcrumb click's navigation ends up truncating the trail (the
   * clicked href is already IN the trail, so `nextBreadcrumbTrail` returns
   * the slice up to it) and how landing back on "/" resets it (empty input). */
  visit: (localCrumbs: Crumb[]) => void
}

export const useBreadcrumbStore = create<BreadcrumbState>((set) => ({
  trail: [],
  visit: (localCrumbs) => set((s) => ({ trail: nextBreadcrumbTrail(s.trail, localCrumbs) })),
}))
