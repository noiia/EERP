// Test-only stand-in for the `server-only` package, which throws when resolved
// outside an RSC bundle. Aliased in vitest.config.ts so server modules import
// cleanly under jsdom; the production build keeps the real marker.
export {}
