import { defineConfig } from 'vitest/config'

// The registry-level test imports crm's OWN views file (CrmViews.ts) to
// register the real base descriptor before applying this module's extension
// — mirroring the Go side's `core/modules/crm` import in module.go. CrmViews
// registers behaviors at import time, reaching the engine's RUNTIME barrel
// (not just types), which reaches MUI. MUI's ESM transitively does a
// directory import of react-transition-group that Node's ESM loader rejects;
// inlining routes it through Vite's resolver instead (same stance as crm's
// own vitest.config.ts and the engine's).
export default defineConfig({
  test: {
    server: {
      deps: { inline: [/@mui\//, 'react-transition-group'] },
    },
  },
})
