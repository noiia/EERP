import { defineConfig } from 'vitest/config'

// The views file registers behaviors/menu actions at import time, so tests
// import the engine's RUNTIME barrel (not just types) — which reaches MUI.
// MUI's ESM transitively does a directory import of react-transition-group
// that Node's ESM loader rejects; inlining routes it through Vite's
// resolver instead (same stance as core/modules/crm's own vitest.config.ts).
export default defineConfig({
  test: {
    server: {
      deps: { inline: [/@mui\//, 'react-transition-group'] },
    },
  },
})
