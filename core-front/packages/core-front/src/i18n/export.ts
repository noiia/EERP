import type { TranslationRegistry } from './registry'

// The write side of i18n: serialize a module's translatable strings back into a
// gettext .po for a target locale. This is the round-trip the settings page exports —
// a translator receives every msgid the module declares (its .pot template, plus
// anything its catalogs already translate), pre-filled with the existing msgstrs for
// that locale and blank where untranslated. Saved as `i18n/<locale>.po` inside the
// module folder, the next build picks it up; the file needs no post-processing.

/** Escape a source string into .po string-literal syntax (inverse of the parser). */
export function escapePo(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
}

/**
 * Render one module's .po for a target locale: every translatable msgid, with the
 * msgstr filled from the module's existing catalog for that locale (empty when
 * untranslated). Returns null when the module declares nothing translatable.
 */
export function renderModulePo(
  registry: TranslationRegistry,
  module: string,
  locale: string,
): string | null {
  const keys = registry.moduleKeys(module)
  if (keys.length === 0) return null
  const entries = registry.moduleEntries(module, locale)

  const lines = [
    `# ${module} — ${locale}. Exported from Settings → Translations.`,
    `# Save as i18n/${locale}.po inside the '${module}' module folder and rebuild.`,
    'msgid ""',
    'msgstr ""',
    `"Project-Id-Version: ${escapePo(module)}\\n"`,
    `"Language: ${escapePo(locale)}\\n"`,
    '"Content-Type: text/plain; charset=UTF-8\\n"',
  ]
  for (const key of keys) {
    lines.push('')
    lines.push(`msgid "${escapePo(key)}"`)
    lines.push(`msgstr "${escapePo(entries[key] ?? '')}"`)
  }
  lines.push('')
  return lines.join('\n')
}
