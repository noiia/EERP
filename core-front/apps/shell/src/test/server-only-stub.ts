// Test-only stand-in for the `server-only` package, which throws when resolved
// outside an RSC bundle. Aliased in vitest.config.ts so engine server modules and
// BFF code import cleanly under jsdom.
export {}
