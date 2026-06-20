import 'server-only'

// @eerp/core-front — SERVER-ONLY public barrel.
//
// The BFF surface: the server ApiClient, RSC data loaders, and permission guards.
// The `server-only` marker makes importing this from a Client Component a build
// error. Populated across Phase 1 (1a ApiClient; 1c loaders; 1d guards).

// 1a — server ApiClient (BFF) + session cookie contract.
export * from './src/api/ApiClient'
export * from './src/api/session-cookies'

// 1c — RSC data loader + server dispatcher.
export * from './src/views/loader'

// 1d — server-side permission guard.
export * from './src/auth/guards'
