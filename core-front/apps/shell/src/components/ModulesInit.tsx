'use client'
// Side-effect import: evaluates every discovered module views file in the BROWSER
// bundle — their import-time registerFieldFunction/registerOnChange calls populate
// the client-side behavior registry the form store validates compute names against —
// and registers each FrontModule with the client moduleRegistry (the relation
// widgets' create wizard resolves the target entity's form descriptor from it).
// The server manifest (generated-modules.ts) only reaches the server bundle — it
// imports the server-only barrel. The twin of I18nInit. Renders nothing.
import '@/generated/generated-modules.client'

export function ModulesInit() {
  return null
}
