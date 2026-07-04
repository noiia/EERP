// Codegen entry point. Run on predev/prebuild/pretypecheck (and re-run when a
// module.json changes). Reads the shared repo-root eerp-config.json, discovers
// frontend views, and writes src/generated/generated-modules.ts (gitignored).

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  discoverFrom,
  discoverTranslationsFrom,
  findRepoRoot,
  renderManifest,
  renderTranslationsManifest,
  translationsForDir,
} from './module-discovery.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const shellRoot = join(scriptDir, '..')

if (!findRepoRoot(scriptDir)) {
  console.warn(
    `[generate-modules] eerp-config.json not reachable from ${scriptDir} — ` +
      'writing an empty manifest (no modules discovered).',
  )
}
const discovered = discoverFrom(scriptDir)
const outFile = join(shellRoot, 'src', 'generated', 'generated-modules.ts')
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, renderManifest(discovered, dirname(outFile)))

const viewCount = discovered.reduce((n, m) => n + m.views.length, 0)
console.log(`[generate-modules] ${viewCount} view(s) from ${discovered.length} module(s) -> ${outFile}`)

// Translations: the shell's own chrome strings first, then every module's i18n/
// catalogs — later registrations win on msgid collisions, so a module may override a
// shell string but never the other way round.
const shellI18n = translationsForDir('shell', shellRoot)
const bundles = [...(shellI18n ? [shellI18n] : []), ...discoverTranslationsFrom(scriptDir)]
const i18nOutFile = join(shellRoot, 'src', 'generated', 'generated-translations.ts')
writeFileSync(i18nOutFile, renderTranslationsManifest(bundles))

const poCount = bundles.reduce((n, b) => n + b.pos.length, 0)
console.log(`[generate-modules] ${poCount} catalog(s) from ${bundles.length} source(s) -> ${i18nOutFile}`)
