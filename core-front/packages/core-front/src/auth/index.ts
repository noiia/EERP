// Client-safe auth surface: the pure permission matcher and the UI gate. The
// server guard (requirePermission) is server-only and lives behind `server.ts`.
export * from './permissions'
export * from './Can'
