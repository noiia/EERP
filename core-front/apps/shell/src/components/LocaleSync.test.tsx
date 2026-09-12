import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import {
  DEFAULT_NUMBER_FORMAT,
  translationRegistry,
  useCompanyStore,
  useFormatStore,
  useI18nStore,
} from '@eerp/core-front'
import { LocaleSync } from './LocaleSync'

// The shared registry is the build-time pool; tests seed it directly (the generated
// manifest is stubbed empty in vitest.config.ts) and reset both it and the store.

function prefs(preferred: string | null, fallback: string | null) {
  return { preferred_locale: preferred, default_locale: fallback }
}

beforeEach(() => {
  translationRegistry.register({ module: 'crm', locale: 'fr', entries: { Save: 'Enregistrer' } })
  translationRegistry.register({ module: 'crm', locale: 'de', entries: { Save: 'Speichern' } })
  useI18nStore.setState({ locale: null, enabledLocales: [] })
  useFormatStore.setState({ ...DEFAULT_NUMBER_FORMAT })
  useCompanyStore.setState({ currency: '' })
})

afterEach(() => {
  translationRegistry.clear()
})

describe('LocaleSync', () => {
  it('applies and auto-enables the user preferred locale', () => {
    render(<LocaleSync preferences={prefs('fr', null)} />)
    expect(useI18nStore.getState().locale).toBe('fr')
    expect(useI18nStore.getState().enabledLocales).toContain('fr')
  })

  it('inherits the workspace default when the user has no preference', () => {
    render(<LocaleSync preferences={prefs(null, 'de')} />)
    expect(useI18nStore.getState().locale).toBe('de')
  })

  it('forces the source language when the user chose "source" over a default', () => {
    useI18nStore.setState({ locale: 'fr', enabledLocales: ['fr'] })
    render(<LocaleSync preferences={prefs('source', 'fr')} />)
    expect(useI18nStore.getState().locale).toBeNull()
  })

  it('keeps the client-persisted locale when preferences could not be read', () => {
    useI18nStore.setState({ locale: 'fr', enabledLocales: ['fr'] })
    render(<LocaleSync preferences={null} />)
    expect(useI18nStore.getState().locale).toBe('fr')
  })

  it('ignores a preference whose catalog the build no longer ships', () => {
    render(<LocaleSync preferences={prefs('pt-BR', null)} />)
    expect(useI18nStore.getState().locale).toBeNull()
    expect(useI18nStore.getState().enabledLocales).toEqual([])
  })

  it('applies the workspace number format to the format mirror', () => {
    render(
      <LocaleSync
        preferences={{
          ...prefs(null, null),
          number_format: { decimal_separator: ',', thousands_separator: ' ' },
        }}
      />,
    )
    expect(useFormatStore.getState().decimalSeparator).toBe(',')
    expect(useFormatStore.getState().thousandsSeparator).toBe(' ')
  })

  it('keeps the format mirror when the workspace never set a format', () => {
    useFormatStore.setState({ decimalSeparator: ',', thousandsSeparator: ' ' })
    render(<LocaleSync preferences={{ ...prefs(null, null), number_format: null }} />)
    expect(useFormatStore.getState().decimalSeparator).toBe(',')
  })

  it('applies the active company currency to the company mirror', () => {
    render(
      <LocaleSync
        preferences={{
          ...prefs(null, null),
          active_company: { id: 'c1', name: 'Acme', currency: 'USD' },
        }}
      />,
    )
    expect(useCompanyStore.getState().currency).toBe('USD')
  })

  it('keeps the company mirror when active_company is absent (the read failed upstream)', () => {
    useCompanyStore.setState({ currency: 'EUR' })
    render(<LocaleSync preferences={{ ...prefs(null, null), active_company: null }} />)
    expect(useCompanyStore.getState().currency).toBe('EUR')
  })
})
