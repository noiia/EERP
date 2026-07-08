// Client-safe API surface. The error model is usable on both sides (components
// display ApiError.code / requestId). The server-only ApiClient + session cookies
// are NOT re-exported here — they reach consumers through the package `server.ts`
// barrel so importing them into a Client Component is a build error.
export * from './errors'
export * from './pictures-client'
