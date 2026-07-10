import { defineConfig } from 'vitest/config'

// The views file imports real runtime bindings from @eerp/core-front
// (FORM_NOTEBOOK_ID, PAGE_SETTINGS_ID) alongside types, so tests reach the
// engine's RUNTIME barrel — which reaches MUI. MUI's ESM transitively does a
// directory import of react-transition-group that Node's ESM loader rejects;
// inlining routes it through Vite's resolver instead (same stance as crm's
// and the engine's own vitest.config.ts).
export default defineConfig({
  test: {
    server: {
      deps: { inline: [/@mui\//, 'react-transition-group'] },
    },
  },
})
