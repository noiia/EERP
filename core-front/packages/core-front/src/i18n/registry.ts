// The translation registry — the i18n analog of the module registry. Modules ship
// gettext catalogs in an `i18n/` folder next to their module.json (`<name>.pot` = the
// source-string template, `<locale>.po` = one translation); the build-time discovery
// parses them and registers one TranslationBundle per (module, locale) here, exactly
// like generated-modules.ts registers FrontModules. The registry merges bundles into
// one catalog per locale (msgid -> msgstr, gettext-style: the source string IS the
// key), so `useT` does a single lookup regardless of which module contributed the
// string. Client-safe: plain data, no server dependencies.

/** One module's parsed catalog for one locale (a compiled `i18n/<locale>.po`). */
export interface TranslationBundle {
  /** BCP-47-ish locale tag from the .po filename, e.g. 'fr' or 'pt-BR'. */
  locale: string
  /** The contributing module (or 'shell' for the host app's own chrome strings). */
  module: string
  /** msgid -> msgstr; empty msgstrs are dropped at parse time (fallback to source). */
  entries: Record<string, string>
}

/** One module's `.pot` template: the source strings it declares as translatable. */
export interface TranslationTemplate {
  module: string
  /** The msgids of the template, i.e. every translatable source string. */
  keys: string[]
}

/** A discovered locale, aggregated across modules — what the settings page lists. */
export interface LocaleInfo {
  locale: string
  /** Modules contributing a .po for this locale, sorted. */
  modules: string[]
  /** Distinct translated msgids across all bundles of this locale. */
  translated: number
  /** Distinct msgids declared across all .pot templates (0 when no template ships). */
  total: number
}

export class TranslationRegistry {
  private readonly bundles: TranslationBundle[] = []
  private readonly templates: TranslationTemplate[] = []
  private readonly catalogs = new Map<string, Record<string, string>>()

  register(bundle: TranslationBundle): this {
    this.bundles.push(bundle)
    this.catalogs.delete(bundle.locale)
    return this
  }

  registerTemplate(template: TranslationTemplate): this {
    this.templates.push(template)
    return this
  }

  /** Every locale any module ships a .po for, sorted by tag. */
  locales(): LocaleInfo[] {
    const templateKeys = new Set(this.templates.flatMap((t) => t.keys))
    const byLocale = new Map<string, TranslationBundle[]>()
    for (const bundle of this.bundles) {
      const group = byLocale.get(bundle.locale) ?? []
      group.push(bundle)
      byLocale.set(bundle.locale, group)
    }
    return [...byLocale.entries()]
      .map(([locale, bundles]) => ({
        locale,
        modules: [...new Set(bundles.map((b) => b.module))].sort(),
        translated: new Set(bundles.flatMap((b) => Object.keys(b.entries))).size,
        total: templateKeys.size,
      }))
      .sort((a, b) => a.locale.localeCompare(b.locale))
  }

  /** True when at least one module ships a .po for the locale. */
  has(locale: string): boolean {
    return this.bundles.some((b) => b.locale === locale)
  }

  /** Every module contributing a template or a catalog, sorted — the export universe. */
  modules(): string[] {
    const names = new Set<string>()
    for (const template of this.templates) names.add(template.module)
    for (const bundle of this.bundles) names.add(bundle.module)
    return [...names].sort()
  }

  /**
   * One module's translatable source strings: its .pot keys plus every msgid any of
   * its catalogs translates (a module without a template still exports what it
   * translates). Template order first — the order translators see.
   */
  moduleKeys(module: string): string[] {
    const keys = new Set<string>()
    for (const template of this.templates) {
      if (template.module === module) for (const key of template.keys) keys.add(key)
    }
    for (const bundle of this.bundles) {
      if (bundle.module === module) for (const key of Object.keys(bundle.entries)) keys.add(key)
    }
    return [...keys]
  }

  /** One module's merged msgid -> msgstr for a locale (later bundles win). */
  moduleEntries(module: string, locale: string): Record<string, string> {
    const merged: Record<string, string> = {}
    for (const bundle of this.bundles) {
      if (bundle.module === module && bundle.locale === locale) Object.assign(merged, bundle.entries)
    }
    return merged
  }

  /**
   * The merged msgid -> msgstr catalog for a locale (empty for unknown locales).
   * Later-registered bundles win on msgid collisions — mirroring the module
   * registry's last-wins route rule. Memoized per locale; registering a new bundle
   * invalidates that locale's memo.
   */
  catalog(locale: string): Record<string, string> {
    const cached = this.catalogs.get(locale)
    if (cached) return cached
    const merged: Record<string, string> = {}
    for (const bundle of this.bundles) {
      if (bundle.locale === locale) Object.assign(merged, bundle.entries)
    }
    this.catalogs.set(locale, merged)
    return merged
  }

  /** Drop everything — test isolation only. */
  clear(): void {
    this.bundles.length = 0
    this.templates.length = 0
    this.catalogs.clear()
  }
}

/**
 * Shared registry the generated translations manifest registers catalogs with and
 * `useT` / the settings page read. One instance per running app (client and server
 * render both import the same manifest, so both sides see the same catalogs).
 */
export const translationRegistry = new TranslationRegistry()
