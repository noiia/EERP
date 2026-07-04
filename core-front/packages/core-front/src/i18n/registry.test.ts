import { beforeEach, describe, expect, it } from 'vitest'
import { TranslationRegistry } from './registry'

describe('TranslationRegistry', () => {
  let registry: TranslationRegistry

  beforeEach(() => {
    registry = new TranslationRegistry()
  })

  it('merges bundles of the same locale across modules', () => {
    registry.register({ locale: 'fr', module: 'shell', entries: { Settings: 'Paramètres' } })
    registry.register({ locale: 'fr', module: 'crm', entries: { Name: 'Nom' } })
    expect(registry.catalog('fr')).toEqual({ Settings: 'Paramètres', Name: 'Nom' })
  })

  it('last-registered bundle wins on msgid collisions', () => {
    registry.register({ locale: 'fr', module: 'a', entries: { Status: 'État' } })
    registry.register({ locale: 'fr', module: 'b', entries: { Status: 'Statut' } })
    expect(registry.catalog('fr').Status).toBe('Statut')
  })

  it('returns an empty catalog for unknown locales', () => {
    expect(registry.catalog('xx')).toEqual({})
    expect(registry.has('xx')).toBe(false)
  })

  it('invalidates the memoized catalog when a new bundle registers', () => {
    registry.register({ locale: 'fr', module: 'a', entries: { Menu: 'Menu' } })
    expect(registry.catalog('fr')).toEqual({ Menu: 'Menu' })
    registry.register({ locale: 'fr', module: 'b', entries: { Logout: 'Déconnexion' } })
    expect(registry.catalog('fr').Logout).toBe('Déconnexion')
  })

  it('aggregates locale info: modules, distinct translated, template total', () => {
    registry.registerTemplate({ module: 'shell', keys: ['Settings', 'Logout'] })
    registry.registerTemplate({ module: 'crm', keys: ['Name', 'Settings'] })
    registry.register({ locale: 'fr', module: 'shell', entries: { Settings: 'Paramètres' } })
    registry.register({ locale: 'fr', module: 'crm', entries: { Name: 'Nom', Settings: 'Paramètres' } })
    registry.register({ locale: 'de', module: 'crm', entries: { Name: 'Name' } })

    const locales = registry.locales()
    expect(locales.map((l) => l.locale)).toEqual(['de', 'fr'])
    const fr = locales.find((l) => l.locale === 'fr')!
    expect(fr.modules).toEqual(['crm', 'shell'])
    // 'Settings' translated by both modules counts once; template keys dedupe too.
    expect(fr.translated).toBe(2)
    expect(fr.total).toBe(3)
  })

  it('clear() empties bundles, templates, and memos', () => {
    registry.registerTemplate({ module: 'crm', keys: ['Name'] })
    registry.register({ locale: 'fr', module: 'crm', entries: { Name: 'Nom' } })
    registry.clear()
    expect(registry.locales()).toEqual([])
    expect(registry.catalog('fr')).toEqual({})
  })
})
