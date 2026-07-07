// Client-safe view engine surface: descriptors (1b), Zustand store factories +
// persisted session/UI stores (1b), and client renderers (1c). The server loader /
// RSC dispatcher (1c) is server-only and lives behind the package `server.ts` barrel.
export * from './descriptor'
export * from './behaviors'
export * from './stores'
export * from './session-store'
export * from './ui-store'
export * from './format-store'
export * from './palette'
export * from './tokens'
export * from './theme'
export * from './renderers'
