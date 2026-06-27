// Codegen entry point. Run on predev/prebuild/pretypecheck (and re-run when a
// module.json changes). Reads the shared repo-root eerp-config.json, discovers
// frontend views, and writes src/generated/generated-modules.ts (gitignored).

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverFrom, findRepoRoot, renderManifest } from './module-discovery.mjs'

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
