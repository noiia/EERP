import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output so the service ships as a self-contained `node server.js`.
  output: 'standalone',
  // Monorepo: trace workspace deps from the repo root.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  // The engine is a workspace package; let Next transpile it directly.
  transpilePackages: ['@eerp/core-front'],
  // Phase 2 adds here: discovery codegen (src/generated/generated-modules.ts) +
  // resolve/transpile of external module dirs from the repo-root eerp-config.json.
}

export default nextConfig
