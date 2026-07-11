import { moduleRegistry } from '@eerp/core-front/server'

// The App Store form's Views notebook page (docs/roadmaps/app-store.md, Phase
// 3 + the live-lifecycle work) needs "which paths does THIS module create or
// edit, from which file, and where does that file actually live" — data the
// frontend's OWN build-time module registry already has for the route half
// (moduleRegistry), combined with the file location Go reports
// (module_dir — manager.go). This file is server-only by construction (it
// imports the server-only moduleRegistry) — never import it from a client
// component, and never turn it into a field `compute` (that runs in the
// browser too).

export interface ModuleViewRow {
  route: string
  filename: string
  filepath: string
  status: 'Created' | 'Inherited'
}

/**
 * Every path `moduleName` creates (its own registered routes) or edits (its
 * own `extends`), each attributed to `filename` — a views file exports
 * exactly ONE FrontModule, so file attribution is 1:1 with the module.
 * `filename` comes from the record's OWN `static_files.views[0]` (Go's
 * module.json data), not the registry; `filepath` joins that with
 * `moduleDir` (Go's `module_dir` — the directory module.json was found in,
 * by convention the file's own module's `views/` subfolder). Empty for a
 * module with no frontend views file at all (backend-only Go modules like
 * auth/pictures/notebook/settings never appear here — they have no
 * module.json, so the App Store never lists them either).
 */
export function moduleViewRows(moduleName: string, filename: string, moduleDir?: string): ModuleViewRow[] {
  const filepath = moduleDir ? `${moduleDir}/views/${filename}` : filename
  const created: ModuleViewRow[] = []
  for (const [path, route] of moduleRegistry.buildRegistry()) {
    if (route.module === moduleName) created.push({ route: path, filename, filepath, status: 'Created' })
  }
  const inherited: ModuleViewRow[] = moduleRegistry
    .extendedPaths(moduleName)
    .map((path) => ({ route: path, filename, filepath, status: 'Inherited' as const }))
  return [...created, ...inherited]
}
