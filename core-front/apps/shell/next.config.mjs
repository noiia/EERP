import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { discoverFrom, findRepoRoot } from './scripts/module-discovery.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The generated manifest imports external module views by RELATIVE path, so no alias
// config is needed. We still resolve the repo root + view sources here to (a) root the
// bundler/trace at the monorepo so external module files are inside the project, and
// (b) keep those sources in the standalone output trace. When the shared config isn't
// reachable (e.g. a Docker build scoped to core-front/), discovery yields nothing and
// the bundler/trace root falls back to the workspace.
const projectRoot = findRepoRoot(__dirname) ?? path.join(__dirname, '../../')
const moduleViewSources = discoverFrom(__dirname).flatMap((m) => m.views.map((v) => v.sourceFile))

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output so the service ships as a self-contained `node server.js`.
  output: 'standalone',
  // Trace from the repo root so external module files (under module_root) are included.
  outputFileTracingRoot: projectRoot,
  // The engine is a workspace package; let Next transpile it directly.
  transpilePackages: ['@eerp/core-front'],
  // Treat the whole monorepo as the Turbopack project root so external module view
  // files (imported from the generated manifest by relative path) are resolved and
  // transpiled like first-party code.
  turbopack: {
    root: projectRoot,
  },
  // webpack fallback (`next build --webpack`): allow importing TS from outside the app.
  experimental: {
    externalDir: true,
  },
  // Keep external module sources in the standalone trace when any are wired.
  ...(moduleViewSources.length ? { outputFileTracingIncludes: { '/**': moduleViewSources } } : {}),
}

export default nextConfig
