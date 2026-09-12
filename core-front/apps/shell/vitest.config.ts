import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Vitest runs the component tests (Next itself does not run them). It uses its own
// Vite pipeline + the React plugin to transform TSX, independent of the Next bundler.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The engine's server barrel imports 'server-only', which throws outside an RSC
      // bundle; alias it to an empty stub so BFF/route code can be unit-tested.
      'server-only': fileURLToPath(new URL('./src/test/server-only-stub.ts', import.meta.url)),
      // The generated translations manifest is a build artefact (gitignored, written
      // by generate-modules.mjs) — stub it so tests neither require a prior codegen
      // run nor inherit whatever catalogs the last build discovered.
      '@/generated/generated-translations': fileURLToPath(
        new URL('./src/test/empty-generated-translations.ts', import.meta.url),
      ),
      // Mirror the tsconfig "@/*" path (vitest doesn't read tsconfig paths).
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    server: {
      // MUI's ESM does a directory import of react-transition-group that Node's ESM
      // loader rejects; inline it through Vite's resolver (the server barrel pulls
      // MUI via the renderers).
      deps: { inline: [/@mui\//, 'react-transition-group'] },
    },
    // Coverage mirrors the backend's go-test-coverage step (see the engine vitest
    // config). Generated artefacts and the BFF test stubs are excluded. Thresholds
    // stay off so the gate reports without blocking until the team sets targets.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['app/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.{test,spec}.{ts,tsx}',
        'src/test/**',
        'src/generated/**',
        'scripts/**',
        '**/*.d.ts',
      ],
    },
  },
})
