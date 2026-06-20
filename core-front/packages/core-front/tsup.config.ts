import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['index.ts', 'server.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  external: ['server-only'],
})
