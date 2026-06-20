// Server-only environment for the BFF. These never reach the browser — the client
// talks to the Next service, the Next service talks to Go.
declare namespace NodeJS {
  interface ProcessEnv {
    /** Go backend origin, e.g. http://localhost:8080. Required at runtime. */
    API_BASE: string
    /** API major version; defaults to "1" when unset. */
    API_VERSION?: string
  }
}
