import { beforeEach, describe, expect, it } from 'vitest'
import { TranslationRegistry } from './registry'
import { escapePo, renderModulePo } from './export'

describe('escapePo', () => {
  it('escapes backslashes, quotes, and control characters', () => {
    expect(escapePo('say "hi"\nc:\\dir\ttab')).toBe('say \\"hi\\"\\nc:\\\\dir\\ttab')
  })
})

describe('renderModulePo', () => {
  let registry: TranslationRegistry

  beforeEach(() => {
    registry = new TranslationRegistry()
    registry.registerTemplate({ module: 'crm', keys: ['Name', 'Email', 'Status'] })
    registry.register({ locale: 'fr', module: 'crm', entries: { Name: 'Nom' } })
  })

  it('emits every template key, pre-filling existing translations of the target locale', () => {
    const po = renderModulePo(registry, 'crm', 'fr')!
    expect(po).toContain('"Language: fr\\n"')
    expect(po).toContain('msgid "Name"\nmsgstr "Nom"')
    // Untranslated keys ship with an empty msgstr, ready for the translator.
    expect(po).toContain('msgid "Email"\nmsgstr ""')
    expect(po).toContain('msgid "Status"\nmsgstr ""')
  })

  it('exports a fresh locale as an all-blank catalog', () => {
    const po = renderModulePo(registry, 'crm', 'de')!
    expect(po).toContain('"Language: de\\n"')
    expect(po).not.toContain('"Nom"')
    expect(po.match(/msgstr ""/g)!.length).toBeGreaterThanOrEqual(3)
  })

  it('includes msgids translated by catalogs but missing from the template', () => {
    registry.register({ locale: 'fr', module: 'crm', entries: { Extra: 'Supplément' } })
    const po = renderModulePo(registry, 'crm', 'fr')!
    expect(po).toContain('msgid "Extra"\nmsgstr "Supplément"')
  })

  it('returns null for a module with nothing translatable', () => {
    expect(renderModulePo(registry, 'unknown', 'fr')).toBeNull()
  })

  it('round-trips through the same syntax the parser reads', () => {
    registry.registerTemplate({ module: 'tricky', keys: ['He said "no"\nthen left'] })
    registry.register({
      locale: 'fr',
      module: 'tricky',
      entries: { 'He said "no"\nthen left': 'Il a dit "non"' },
    })
    const po = renderModulePo(registry, 'tricky', 'fr')!
    expect(po).toContain('msgid "He said \\"no\\"\\nthen left"')
    expect(po).toContain('msgstr "Il a dit \\"non\\""')
  })
})

describe('TranslationRegistry export accessors', () => {
  it('modules() unions template and bundle contributors, sorted', () => {
    const registry = new TranslationRegistry()
    registry.registerTemplate({ module: 'shell', keys: ['Menu'] })
    registry.register({ locale: 'fr', module: 'crm', entries: { Name: 'Nom' } })
    expect(registry.modules()).toEqual(['crm', 'shell'])
  })

  it('moduleKeys keeps template order and appends catalog-only msgids', () => {
    const registry = new TranslationRegistry()
    registry.registerTemplate({ module: 'crm', keys: ['Name', 'Email'] })
    registry.register({ locale: 'fr', module: 'crm', entries: { Extra: 'X', Name: 'Nom' } })
    expect(registry.moduleKeys('crm')).toEqual(['Name', 'Email', 'Extra'])
  })

  it('moduleEntries scopes to one module and one locale', () => {
    const registry = new TranslationRegistry()
    registry.register({ locale: 'fr', module: 'crm', entries: { Name: 'Nom' } })
    registry.register({ locale: 'fr', module: 'shell', entries: { Menu: 'Menu' } })
    registry.register({ locale: 'de', module: 'crm', entries: { Name: 'Name' } })
    expect(registry.moduleEntries('crm', 'fr')).toEqual({ Name: 'Nom' })
  })
})
