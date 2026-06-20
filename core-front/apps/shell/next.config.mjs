import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { backendApiBase, backendApiVersion, findRepoRoot, readConfig } from './scripts/module-discovery.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Root the bundler + standalone trace at the monorepo so the generated manifest's
// RELATIVE imports of external module views (under module_root, outside the workspace)
// resolve and transpile. Falls back to the workspace when the config isn't reachable
// (e.g. a build with no repo-root eerp-config). NOTE: because this is the monorepo
// root, the standalone entry is `core-front/apps/shell/server.js` (the Dockerfile runs
// it from there).
const workspaceRoot = path.join(__dirname, '../../')
const repoRoot = findRepoRoot(__dirname)
const config = repoRoot ? readConfig(repoRoot) : null
const projectRoot = repoRoot ?? workspaceRoot

// API_BASE / API_VERSION come from the shared eerp-config.json (backend_host[:port] +
// backend_version), baked at build time. An explicit env var still wins (e.g. the
// Docker build arg) so deployments can point at the backend service without editing
// the config. `||` (not `??`) so an empty value also falls back to the config.
const apiBase = process.env.API_BASE || (config ? backendApiBase(config) : undefined)
const apiVersion = process.env.API_VERSION || (config ? backendApiVersion(config) : undefined)
const serverEnv = {
  ...(apiBase ? { API_BASE: apiBase } : {}),
  ...(apiVersion ? { API_VERSION: apiVersion } : {}),
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output so the service ships as a self-contained `node server.js`.
  output: 'standalone',
  // Backend connection (BFF) resolved from the shared config; baked into the build.
  env: serverEnv,
  // Bundler + standalone trace rooted at the monorepo (see projectRoot above).
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
}

export default nextConfig
