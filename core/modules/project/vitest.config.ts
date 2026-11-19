import { defineConfig } from 'vitest/config'

// @eerp/core-front's runtime barrel reaches MUI, whose ESM does a directory
// import of react-transition-group that Node's ESM loader rejects; inlining
// routes it through Vite's resolver instead (same stance as every other
// module's vitest.config.ts).
export default defineConfig({
  test: {
    server: {
      deps: { inline: [/@mui\//, 'react-transition-group'] },
    },
  },
})
