import { moduleRegistry } from '@eerp/core-front/server'

// The App Store form's Views notebook page (docs/roadmaps/app-store.md, Phase
// 3) needs "which paths does THIS module create or edit, and from which
// file" — data the frontend's OWN build-time module registry already has
// (moduleRegistry), never Go (its /api/v1/modules API only ever reads
// module.json). This file is server-only by construction (it imports the
// server-only moduleRegistry) — never import it from a client component, and
// never turn it into a field `compute` (that runs in the browser too).

export interface ModuleViewRow {
  view: string
  file: string
  kind: 'Created' | 'Edited'
}

/**
 * Every path `moduleName` creates (its own registered routes) or edits (its
 * own `extends`), each attributed to `file` — a views file exports exactly
 * ONE FrontModule, so file attribution is 1:1 with the module, and `file`
 * itself comes from the record's OWN `static_files.views[0]` (Go's module.json
 * data), not the registry. Empty for a module with no frontend views file at
 * all (backend-only Go modules like auth/pictures/notebook/settings never
 * appear here — they have no module.json, so the App Store never lists them
 * either).
 */
export function moduleViewRows(moduleName: string, file: string): ModuleViewRow[] {
  const created: ModuleViewRow[] = []
  for (const [path, route] of moduleRegistry.buildRegistry()) {
    if (route.module === moduleName) created.push({ view: path, file, kind: 'Created' })
  }
  const edited: ModuleViewRow[] = moduleRegistry
    .extendedPaths(moduleName)
    .map((path) => ({ view: path, file, kind: 'Edited' }))
  return [...created, ...edited]
}
