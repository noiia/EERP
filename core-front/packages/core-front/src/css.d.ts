// Ambient declaration for CSS side-effect imports (React Flow's stylesheet in
// views/diagram/wbs-renderer.tsx): the host's bundler (Next) loads the file, tsc only
// needs to know the import exists (TS2882 otherwise).
declare module '*.css'
