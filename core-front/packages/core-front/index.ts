// @eerp/core-front — public API barrel (the frontend "ABI").
//
// Everything a module or the host shell may import lives behind this file.
// Reaching into ./src/* directly from outside the package is forbidden.
// Populated across Phase 1 (ApiClient, descriptors, controllers, renderers,
// permissions, module registry); intentionally surface-only for Phase 0.

export * from './src/api'
export * from './src/views'
export * from './src/auth'
export * from './src/registry'
