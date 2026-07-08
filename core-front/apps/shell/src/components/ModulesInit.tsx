'use client'
// Side-effect import: evaluates every discovered module views file in the BROWSER
// bundle, so their import-time registerFieldFunction/registerOnChange calls populate
// the client-side behavior registry the form store validates compute names against.
// The server manifest (generated-modules.ts) only reaches the server bundle — it
// imports the server-only barrel. The twin of I18nInit for behaviors. Renders nothing.
import '@/generated/generated-modules.client'

export function ModulesInit() {
  return null
}
