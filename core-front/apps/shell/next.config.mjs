import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  backendApiBase,
  backendApiVersion,
  resolveRepoConfig,
} from './scripts/module-discovery.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Root the bundler + standalone trace at the monorepo so the generated manifest's
// RELATIVE imports of external module views (under module_root, outside the workspace)
// resolve and transpile. Falls back to the workspace when neither eerp-config.json nor
// the MODULE_ROOTS/REPO_ROOT build ARGs (core-front/Dockerfile's production path,
// resolveRepoConfig's own doc comment) resolve a repo root. NOTE: because this is the
// monorepo root, the standalone entry is `core-front/apps/shell/server.js` (the
// Dockerfile runs it from there).
const workspaceRoot = path.join(__dirname, '../../')
const resolved = resolveRepoConfig(__dirname)
const repoRoot = resolved?.repoRoot ?? null
const config = resolved?.config ?? null
const projectRoot = repoRoot ?? workspaceRoot

// API_VERSION comes from the shared eerp-config.json (backend_version), baked at build
// time. An explicit env var still wins. `||` (not `??`) so an empty value also falls
// back to the config. Falls back to '1' (matching bff.ts's own default) so the value
// baked into the client bundle -- and the rewrite below -- is never undefined.
const apiVersion = process.env.API_VERSION || (config ? backendApiVersion(config) : undefined) || '1'
const serverEnv = {
  API_VERSION: apiVersion,
}

// API_BASE is deliberately NOT put through the inlined `env` below: that key bakes a
// literal string into every bundle at BUILD time -- server included -- so a container's
// real API_BASE env var could never override it at start (this was the actual bug: the
// image always dialed whatever hostname CI happened to build with, no matter what
// compose/podman set at runtime). bff.ts/ApiClient.ts read `process.env.API_BASE`
// directly, which the standalone `node server.js` resolves LIVE against its real
// environment on every request. This line only seeds a dev-convenience default (from
// eerp-config.json) into THIS process's env for `next dev` -- `next build`'s standalone
// output never re-executes this file at container start, so it has zero effect on the
// shipped image; production must set a real API_BASE env var.
if (!process.env.API_BASE && config) {
  const devDefault = backendApiBase(config)
  if (devDefault) process.env.API_BASE = devDefault
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output so the service ships as a self-contained `node server.js`.
  output: 'standalone',
  // API_VERSION is inlined into BOTH the server and client bundles (Next's `env` config
  // behavior) -- needed so client components can build a versioned BFF URL from
  // `process.env.API_VERSION` without a NEXT_PUBLIC_ prefix (src/lib/auth-url.ts).
  // API_BASE deliberately stays OUT of this object -- see the comment above.
  env: serverEnv,
  // The browser-facing auth BFF paths stay versioned (matching the Go API's own
  // /api/v{N}/ shape, for a consistent surface through the api-gateway) but the actual
  // route handler stays unversioned at /api/auth/* — that's where the HttpOnly session
  // cookie gets set, and duplicating it per version would just be two copies to keep in
  // sync. This rewrite is the seam between the two, driven by the same apiVersion the
  // server-side Go client already uses.
  async rewrites() {
    return [{ source: `/api/v${apiVersion}/auth/:path*`, destination: '/api/auth/:path*' }]
  },
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
