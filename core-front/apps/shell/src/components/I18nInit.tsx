'use client'
// Side-effect import: registers every discovered translation catalog (each module's
// i18n/*.po, parsed to JSON at build time) with the engine's shared
// translationRegistry — the i18n twin of layout.tsx importing generated-modules.
// A Client Component so the catalogs evaluate in the BROWSER bundle too: useT and the
// translations settings page read the registry client-side. Renders nothing.
import '@/generated/generated-translations'

export function I18nInit() {
  return null
}
