import 'server-only'

// @eerp/core-front — SERVER-ONLY public barrel.
//
// The BFF surface: the server ApiClient, RSC data loaders, and permission guards
// (Phase 1a/1c/1d). The `server-only` marker makes importing this from a Client
// Component a build error. Intentionally surface-only for Phase 0.

export {}
