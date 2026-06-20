import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Vitest runs the component tests (Next itself does not run them). It uses its own
// Vite pipeline + the React plugin to transform TSX, independent of the Next bundler.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
