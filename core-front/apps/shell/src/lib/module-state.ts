import { createServerApiClient } from '@eerp/core-front/server'

// Live module active-state — the frontend half of "activate/deactivate takes
// effect immediately, no rebuild" (docs/roadmaps/app-store.md). Discovery now
// compiles EVERY module's views/tiles regardless of module.json `active`
// (module-discovery.mjs), so a deactivated module's route/tile still EXISTS
// in the running build; this is what hides/blocks it at request time instead,
// reading the same Go-sourced list the App Store's own catalog renders from.
// Cached under the 'modules' Data Cache tag — the same tag setModuleActive /
// reloadModule already revalidate on every write, so a toggle is reflected on
// the very next page load with no extra plumbing.

/** Every module name Go currently reports as active. */
export async function activeModuleNames(): Promise<Set<string>> {
  const records = await createServerApiClient().list<{ name: string; active: boolean }>('modules')
  const names = new Set(records.filter((r) => r.active).map((r) => r.name))
  // Go's List() excludes the App Store's own record from the catalog (Part 1
  // — it manages other apps, it isn't one to install/manage), so it never
  // appears here either. It's also permanently self-protected against
  // deactivation, so it's always active regardless.
  names.add('appstore')
  return names
}
