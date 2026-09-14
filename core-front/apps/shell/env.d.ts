// Environment for the BFF. API_BASE/API_VERSION are consumed server-side (the Next
// service talks to Go) but API_VERSION is ALSO inlined into the client bundle by
// next.config.mjs's `env` — it's what builds the versioned browser-facing auth BFF URL
// (see src/lib/auth-url.ts), even though the browser never talks to Go directly.
declare namespace NodeJS {
  interface ProcessEnv {
    /** Go backend origin, e.g. http://localhost:8080. Required at runtime. */
    API_BASE: string
    /** API major version; defaults to "1" when unset. */
    API_VERSION?: string
  }
}
