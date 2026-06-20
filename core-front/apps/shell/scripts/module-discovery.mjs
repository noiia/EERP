// Build-time module discovery — the portability centerpiece. Reads the SHARED
// repo-root eerp-config.json (the same file the Go backend reads) and walks each
// module_root for module.json files declaring frontend views. Used by BOTH the
// codegen (generate-modules.mjs, writes the static-import manifest) and next.config
// (computes resolve aliases). Build-time only: the running service never reads this.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

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
 * Discover every module declaring `static_files.views`. Returns one entry per module
 * (sorted by name for deterministic output), each carrying its absolute dir and the
 * resolved view files with their `@module/<name>/views/<file>` import specifiers.
 * Modules without frontend views (Go-only) are skipped.
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
      discovered.push({ name, moduleDir, views: viewFiles })
    }
  }

  discovered.sort((a, b) => a.name.localeCompare(b.name))
  return discovered
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

  const identifiers = []
  let i = 0
  for (const module of discovered) {
    for (const view of module.views) {
      const id = `m${i++}`
      identifiers.push(id)
      lines.push(`import ${id} from '${toImportSpecifier(fromDir, view.sourceFile)}'`)
    }
  }

  lines.push('')
  for (const id of identifiers) lines.push(`moduleRegistry.register(${id})`)
  lines.push('')
  lines.push('export { moduleRegistry }')
  lines.push('')
  return lines.join('\n')
}
