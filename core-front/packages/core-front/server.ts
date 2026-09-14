import 'server-only'

// @eerp/core-front — SERVER-ONLY public barrel.
//
// The BFF surface: the server ApiClient, RSC data loaders, and permission guards.
// The `server-only` marker makes importing this from a Client Component a build
// error. Populated across Phase 1 (1a ApiClient; 1c loaders; 1d guards).

// 1a — server ApiClient (BFF) + session cookie contract + error model. The error
// model is isomorphic (also on the client barrel); re-exported here so server code
// (BFF routes) can use ApiError/parseError without importing the client barrel.
export * from './src/api/ApiClient'
export * from './src/api/session-cookies'
export * from './src/api/errors'

// 1c — RSC data loader + server dispatcher.
export * from './src/views/loader'

// 1d — server-side permission guard.
export * from './src/auth/guards'

// 1e — module registry (isomorphic; also on the client barrel). Re-exported here so
// the catch-all route can resolve routes server-side without pulling the client
// stores (and their localStorage access) in through the client barrel.
export * from './src/registry'
