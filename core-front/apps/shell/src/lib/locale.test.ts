import { describe, expect, it } from 'vitest'
import { resolveEffectiveLocale, type LocalePreferences } from './locale'

const POOL = ['fr', 'de']

function prefs(preferred: string | null, fallback: string | null): LocalePreferences {
  return { preferred_locale: preferred, default_locale: fallback }
}

describe('resolveEffectiveLocale', () => {
  it('renders the user choice when the build ships it', () => {
    expect(resolveEffectiveLocale(prefs('fr', 'de'), POOL)).toBe('fr')
  })

  it('inherits the workspace default when the user has no preference', () => {
    expect(resolveEffectiveLocale(prefs(null, 'de'), POOL)).toBe('de')
  })

  it('lets "source" override a translated workspace default', () => {
    expect(resolveEffectiveLocale(prefs('source', 'fr'), POOL)).toBeNull()
  })

  it('falls back to the default when the preferred catalog is no longer shipped', () => {
    expect(resolveEffectiveLocale(prefs('pt-BR', 'fr'), POOL)).toBe('fr')
  })

  it('renders the source language when nothing resolvable is configured', () => {
    expect(resolveEffectiveLocale(prefs(null, null), POOL)).toBeNull()
    expect(resolveEffectiveLocale(prefs(null, 'es'), POOL)).toBeNull()
    expect(resolveEffectiveLocale(prefs('fr', 'fr'), [])).toBeNull()
  })
})
