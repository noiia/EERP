// FrontModule contract + ModuleRegistry. Isomorphic (pure data): the build-time
// discovery registers modules here and the catch-all route reads buildRegistry().
export * from './registry'
// The inheritance engine: ViewExtension/Operation + the pure applyExtension()
// the registry runs at registration time (docs/roadmaps/view-customization.md).
export * from './extensions'
