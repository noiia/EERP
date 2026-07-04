// @eerp/core-front — public CLIENT API barrel (the frontend "ABI").
//
// Everything a module or the Next host may import on the client lives behind this
// file; the server-only surface (ApiClient, RSC loaders, guards) lives in server.ts.
// Reaching into ./src/* directly from outside the package is forbidden.
// Populated across Phase 1 (descriptors, Zustand stores, renderers, permissions,
// module registry); intentionally surface-only for Phase 0.

export * from './src/api'
export * from './src/views'
export * from './src/auth'
export * from './src/registry'
export * from './src/i18n'
