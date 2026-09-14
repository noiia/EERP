// Builds the browser-facing URL for the auth BFF routes. The version is baked into the
// client bundle from the same config-driven value the server uses (see next.config.mjs's
// `env`/`rewrites`) — never hardcoded here — and next.config.mjs rewrites this versioned
// path back to the actual (unversioned) route handler that sets the session cookie.
export function authBffUrl(path: 'login' | 'logout' | 'refresh'): string {
  return `/api/v${process.env.API_VERSION ?? '1'}/auth/${path}`
}
