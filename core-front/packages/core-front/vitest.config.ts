import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// The engine ships its own Vitest pipeline (independent of the Next bundler) so
// descriptors, stores, renderers, and the server ApiClient can be unit-tested in
// isolation. `server-only` is aliased to an empty stub: that package throws when
// resolved outside a React Server Component bundle, which would break ApiClient
// tests running in jsdom — the tests instead mock next/headers + next/cache.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'server-only': fileURLToPath(new URL('./src/test/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    server: {
      // MUI's ESM transitively does a directory import of react-transition-group that
      // Node's ESM loader rejects; inlining routes it through Vite's resolver instead.
      deps: { inline: [/@mui\//, 'react-transition-group'] },
    },
    // Coverage mirrors the backend's go-test-coverage step: reported on every CI run
    // (text for logs, lcov for tooling, json-summary for badges/PR diffs). Thresholds
    // stay off — like the commented thresholds in .github/.testcoverage.yml — so the
    // gate reports without blocking until the team sets targets.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.{test,spec}.{ts,tsx}', 'src/test/**', '**/*.d.ts'],
    },
  },
})
