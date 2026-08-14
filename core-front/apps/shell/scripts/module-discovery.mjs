// Build-time module discovery — the portability centerpiece. Reads the SHARED
// repo-root eerp-config.json (the same file the Go backend reads) and walks each
// module_root for module.json files declaring frontend views. Used by BOTH the
// codegen (generate-modules.mjs, writes the static-import manifest) and next.config
// (computes resolve aliases). Build-time only: the running service never reads this.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { parsePo } from './po.mjs'

/**
 * Walk up from startDir until eerp-config.json is found; return that directory, or
 * null when it isn't reachable. Discovery degrades gracefully to "no modules" rather
 * than throwing — e.g. a Docker build whose context is scoped to core-front/ has no
 * repo-root config and (by design) no module roots in the image.
 */
export function findRepoRoot(startDir) {
  let dir = startDir
  for (;;) {
    if (existsSync(join(dir, 'eerp-config.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Discover module views starting from a directory inside the repo. Resolves the
 * shared config by walking up; returns [] (no modules) when no config is reachable.
 */
export function discoverFrom(startDir) {
  const repoRoot = findRepoRoot(startDir)
  return repoRoot ? discoverModuleViews(repoRoot, readConfig(repoRoot)) : []
}

export function readConfig(repoRoot) {
  return JSON.parse(readFileSync(join(repoRoot, 'eerp-config.json'), 'utf8'))
}

/**
 * Build the backend origin the frontend BFF calls, from the shared config:
 * {scheme}{backend_host}[:{backend_port}]. Falls back to public_address, defaults the
 * scheme to http://, and omits the port when backend_port is empty. Returns undefined
 * when no host is configured. This is the API_BASE the ApiClient/BFF use.
 */
export function backendApiBase(config) {
  let host = config.backend_host || config.public_address || ''
  if (!host) return undefined
  if (!/^https?:\/\//.test(host)) host = `http://${host}`
  return config.backend_port ? `${host}:${config.backend_port}` : host
}

/**
 * The API version number from backend_version, normalized to a bare number (the
 * ApiClient builds `/api/v{version}`, so "v1" -> "1"). Returns undefined when unset.
 */
export function backendApiVersion(config) {
  if (!config.backend_version) return undefined
  return String(config.backend_version).replace(/^v/i, '')
}

function walkForModuleJson(dir, found) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkForModuleJson(full, found)
    else if (entry.name === 'module.json') found.push(full)
  }
  return found
}

/**
 * Order modules so every dependency registers before its dependents — a view
 * EXTENSION targeting another module's route needs that route already
 * registered, and `module.json` `depends` is the declared relationship
 * (docs/roadmaps/view-customization.md, Phase 3). A depends entry naming a
 * module NOT in this discovery pass (Go-only, or simply absent) is not an
 * error here — this function only orders what it found; the Go loader is the
 * authority on whether a dependency exists at all. Ties (no ordering relation
 * either way) break by name, for deterministic output across runs. A cycle
 * is a build error naming the chain — unlike the Go loader, which orders by a
 * manually-set `priority` integer (no computed graph, no cycle detection),
 * this computes the order FROM the declared graph directly, so a broken
 * dependency cycle fails loud here instead of silently registering in
 * whatever order the filesystem walk happened to produce.
 */
export function topoSortModules(modules) {
  const byName = new Map(modules.map((m) => [m.name, m]))
  const state = new Map()
  const ordered = []

  function visit(mod, chain) {
    if (state.get(mod.name) === 'done') return
    if (state.get(mod.name) === 'visiting') {
      throw new Error(
        `[generate-modules] dependency cycle: ${[...chain, mod.name].join(' -> ')}`,
      )
    }
    state.set(mod.name, 'visiting')
    for (const dep of mod.depends ?? []) {
      const depModule = byName.get(dep)
      if (depModule) visit(depModule, [...chain, mod.name])
    }
    state.set(mod.name, 'done')
    ordered.push(mod)
  }

  for (const mod of [...modules].sort((a, b) => a.name.localeCompare(b.name))) {
    visit(mod, [])
  }
  return ordered
}

/**
 * Discover every module declaring `static_files.views`. Returns one entry per module,
 * in `depends` TOPOLOGICAL order (name as tie-break — topoSortModules), each carrying
 * its absolute dir, the resolved view files with their import specifiers, its
 * `app_mode` flag (module.json `app_mode: true` = present the module as a full
 * application: a tile on the landing menu; default false = routes only, no tile), and
 * its `depends` list (threaded into the generated manifest's registration options —
 * the registry's depends-coverage warning needs it). Modules without frontend views
 * (Go-only) are skipped. Deactivated modules (`active: false`) are NOT skipped —
 * every discovered module's views/tiles compile in regardless of `active`
 * (docs/roadmaps/app-store.md, live lifecycle): the backend now gates a
 * deactivated module's data access live, at request time, rather than never
 * loading it — compiling its route too is what lets the frontend gate the
 * same way (live, from the current active state — apps/shell/src/lib/
 * module-state.ts) instead of needing a rebuild every time a module toggles.
 */
export function discoverModuleViews(repoRoot, config) {
  const roots = Array.isArray(config.module_root) ? config.module_root : []
  const discovered = []

  for (const root of roots) {
    const rootAbs = resolve(repoRoot, root)
    for (const moduleJsonPath of walkForModuleJson(rootAbs, [])) {
      let meta
      try {
        meta = JSON.parse(readFileSync(moduleJsonPath, 'utf8'))
      } catch {
        continue
      }
      const views = meta?.static_files?.views
      if (!Array.isArray(views) || views.length === 0) continue

      const moduleDir = dirname(moduleJsonPath)
      const name = typeof meta.name === 'string' && meta.name ? meta.name : basename(moduleDir)
      const viewFiles = views
        .filter((file) => typeof file === 'string')
        .map((file) => ({ file, sourceFile: join(moduleDir, 'views', file) }))
        .filter((v) => existsSync(v.sourceFile) && statSync(v.sourceFile).isFile())

      if (viewFiles.length === 0) continue
      const depends = Array.isArray(meta.depends) ? meta.depends.filter((d) => typeof d === 'string') : []
      const icon = typeof meta.menu_icon === 'string' ? meta.menu_icon : undefined
      discovered.push({ name, moduleDir, appMode: meta.app_mode === true, depends, icon, views: viewFiles })
    }
  }

  return topoSortModules(discovered)
}

/**
 * The gettext catalogs of one directory's `i18n/` folder: `<locale>.po` files (the
 * translations) and `*.pot` templates (the declared source strings). Returns null when
 * the folder is absent or empty — the common case for modules without translations.
 * Used both for business modules (dir = next to module.json) and for the shell app's
 * own chrome strings (dir = apps/shell, name = 'shell').
 */
export function translationsForDir(name, dir) {
  const i18nDir = join(dir, 'i18n')
  let entries
  try {
    entries = readdirSync(i18nDir, { withFileTypes: true })
  } catch {
    return null
  }
  const pos = []
  const pots = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name.endsWith('.po')) {
      pos.push({ locale: basename(entry.name, '.po'), file: join(i18nDir, entry.name) })
    } else if (entry.name.endsWith('.pot')) {
      pots.push(join(i18nDir, entry.name))
    }
  }
  if (pos.length === 0 && pots.length === 0) return null
  pos.sort((a, b) => a.locale.localeCompare(b.locale))
  pots.sort()
  return { name, pos, pots }
}

/**
 * Discover every module shipping an `i18n/` folder (sorted by name). Independent of
 * `static_files.views` on purpose: a Go-only module still contributes translations —
 * e.g. for entity labels other modules' views render. Locale = the .po basename
 * ('i18n/fr.po' -> 'fr'); the module never declares locales in module.json, dropping
 * a .po in the folder is the whole contract (mirrors .wasm auto-discovery).
 * Deactivated modules (`active: false`) are NOT skipped, same reasoning as
 * discoverModuleViews above: a module reactivated at runtime needs its
 * strings available immediately, without a rebuild.
 */
export function discoverModuleTranslations(repoRoot, config) {
  const roots = Array.isArray(config.module_root) ? config.module_root : []
  const discovered = []

  for (const root of roots) {
    const rootAbs = resolve(repoRoot, root)
    for (const moduleJsonPath of walkForModuleJson(rootAbs, [])) {
      let meta
      try {
        meta = JSON.parse(readFileSync(moduleJsonPath, 'utf8'))
      } catch {
        continue
      }
      const moduleDir = dirname(moduleJsonPath)
      const name = typeof meta.name === 'string' && meta.name ? meta.name : basename(moduleDir)
      const translations = translationsForDir(name, moduleDir)
      if (translations) discovered.push(translations)
    }
  }

  discovered.sort((a, b) => a.name.localeCompare(b.name))
  return discovered
}

/** i18n twin of discoverFrom(): resolve the shared config by walking up, or []. */
export function discoverTranslationsFrom(startDir) {
  const repoRoot = findRepoRoot(startDir)
  return repoRoot ? discoverModuleTranslations(repoRoot, readConfig(repoRoot)) : []
}

/**
 * Render the generated translations manifest: each .po/.pot parsed to JSON at build
 * time (the browser never sees gettext syntax or a parser) and registered into the
 * engine's shared translationRegistry as an import side effect — the exact pattern of
 * the module manifest. Client-safe import: the registry lives in the CLIENT barrel, so
 * catalogs are available to both the RSC render and the hydrated client.
 */
export function renderTranslationsManifest(bundles) {
  const lines = [
    '// AUTO-GENERATED by scripts/generate-modules.mjs — do not edit.',
    '// Parsed from each module\'s i18n/*.po|*.pot (repo-root eerp-config.json',
    '// module_root + the shell\'s own i18n/). Gitignored. Importing it registers',
    '// every translation catalog with the shared translationRegistry.',
    "import { translationRegistry } from '@eerp/core-front'",
    '',
  ]

  for (const bundle of bundles) {
    for (const pot of bundle.pots) {
      const { keys } = parsePo(readFileSync(pot, 'utf8'))
      lines.push(
        `translationRegistry.registerTemplate(${JSON.stringify({ module: bundle.name, keys })})`,
      )
    }
    for (const po of bundle.pos) {
      const { entries } = parsePo(readFileSync(po.file, 'utf8'))
      lines.push(
        `translationRegistry.register(${JSON.stringify({
          locale: po.locale,
          module: bundle.name,
          entries,
        })})`,
      )
    }
  }

  lines.push('')
  lines.push('export { translationRegistry }')
  lines.push('')
  return lines.join('\n')
}

/**
 * Import specifier for a view, as a RELATIVE path from the generated manifest's
 * directory to the view source (extensionless, posix slashes). Relative imports
 * resolve natively in Turbopack, webpack, and tsc with no bundler-specific alias
 * config — and the modules can still live ANYWHERE on disk (the path just gets
 * longer). Turbopack's resolveAlias rejects absolute FS paths, which is why this is
 * a relative import rather than the originally-planned '@module/<name>' alias.
 */
export function toImportSpecifier(fromDir, sourceFile) {
  let rel = relative(fromDir, sourceFile).replace(/\\/g, '/').replace(/\.(ts|tsx)$/, '')
  if (!rel.startsWith('.')) rel = `./${rel}`
  return rel
}

/**
 * The `register(id, options)` call for one module — `options` omitted when
 * both appMode is false and depends is empty (matches the pre-Phase-3 output
 * for modules touching neither). `depends` rides along so the registry's
 * extension-coverage warning (registry.ts) can check it at registration.
 */
function renderRegisterCall(r) {
  const parts = []
  if (r.appMode) parts.push('appMode: true')
  if (r.depends.length > 0) parts.push(`depends: ${JSON.stringify(r.depends)}`)
  if (r.icon) parts.push(`icon: ${JSON.stringify(r.icon)}`)
  return parts.length > 0
    ? `moduleRegistry.register(${r.id}, { ${parts.join(', ')} })`
    : `moduleRegistry.register(${r.id})`
}

/**
 * Render the generated manifest: static imports of each view's default-exported
 * FrontModule plus a register() call into the single shared ModuleRegistry. Static
 * (not dynamic) imports so the bundler tree-shakes normally. `fromDir` is the
 * directory the manifest is written to (import paths are relative to it).
 */
export function renderManifest(discovered, fromDir) {
  const lines = [
    '// AUTO-GENERATED by scripts/generate-modules.mjs — do not edit.',
    '// Regenerated on predev/prebuild/pretypecheck from the repo-root eerp-config.json',
    "// module_root. Gitignored. Importing it registers every module's FrontModule.",
    "import { moduleRegistry } from '@eerp/core-front/server'",
  ]

  const registrations = []
  let i = 0
  for (const module of discovered) {
    for (const view of module.views) {
      const id = `m${i++}`
      registrations.push({ id, appMode: module.appMode, depends: module.depends ?? [], icon: module.icon })
      lines.push(`import ${id} from '${toImportSpecifier(fromDir, view.sourceFile)}'`)
    }
  }

  lines.push('')
  // app_mode + depends ride along from module.json: registration metadata (how
  // the shell presents the module, what it declares depending on), not part of
  // the FrontModule the views file exports.
  for (const r of registrations) lines.push(renderRegisterCall(r))
  lines.push('')
  lines.push('export { moduleRegistry }')
  lines.push('')
  return lines.join('\n')
}

/**
 * Render the CLIENT twin of the manifest: the same imports + registrations as
 * the server manifest, but through the CLIENT barrel so it may enter the
 * browser bundle. Two things need to evaluate client-side, and both registries
 * live per-bundle: the views files' import-time behavior registrations
 * (registerFieldFunction / registerOnChange — the form store validates compute
 * names against them), and the module registrations themselves (the relation
 * widgets' create wizard looks the target entity's form descriptor up in the
 * client moduleRegistry). During SSR both manifests run against the same
 * registry instance — register() is idempotent by module name, so the double
 * evaluation is harmless. A client component (ModulesInit) imports this file;
 * mirrors the generated-translations / I18nInit pattern.
 */
export function renderClientManifest(discovered, fromDir) {
  const lines = [
    '// AUTO-GENERATED by scripts/generate-modules.mjs — do not edit.',
    '// CLIENT twin of generated-modules.ts (imported by ModulesInit): evaluates',
    '// every module views file in the BROWSER bundle — behavior registrations run',
    '// at import time — and registers each FrontModule with the client-side',
    '// moduleRegistry (idempotent under SSR double evaluation). Gitignored.',
    "import { moduleRegistry } from '@eerp/core-front'",
  ]

  const registrations = []
  let i = 0
  for (const module of discovered) {
    for (const view of module.views) {
      const id = `m${i++}`
      registrations.push({ id, appMode: module.appMode, depends: module.depends ?? [], icon: module.icon })
      lines.push(`import ${id} from '${toImportSpecifier(fromDir, view.sourceFile)}'`)
    }
  }

  lines.push('')
  for (const r of registrations) lines.push(renderRegisterCall(r))
  lines.push('')
  return lines.join('\n')
}
