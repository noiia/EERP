import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { SOURCE_LOCALE, useI18nStore } from './i18n-store'
import { translationRegistry } from './registry'
import { localeDisplayName, translate, useT } from './translate'

function Greeting() {
  const t = useT()
  return <span>{t('Settings')}</span>
}

describe('translate / useT', () => {
  beforeEach(() => {
    translationRegistry.register({
      locale: 'fr',
      module: 'shell',
      entries: { Settings: 'Paramètres' },
    })
  })

  afterEach(() => {
    translationRegistry.clear()
    useI18nStore.setState({ locale: SOURCE_LOCALE, enabledLocales: [] })
  })

  it('translates a known source string', () => {
    expect(translate('fr', 'Settings')).toBe('Paramètres')
  })

  it('falls back to the source string when untranslated or locale is source', () => {
    expect(translate('fr', 'Unmapped text')).toBe('Unmapped text')
    expect(translate(SOURCE_LOCALE, 'Settings')).toBe('Settings')
  })

  it('useT re-renders live when the active locale changes', () => {
    render(<Greeting />)
    expect(screen.getByText('Settings')).toBeInTheDocument()
    act(() => useI18nStore.getState().setLocale('fr'))
    expect(screen.getByText('Paramètres')).toBeInTheDocument()
    act(() => useI18nStore.getState().setLocale(SOURCE_LOCALE))
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('localeDisplayName resolves names and tolerates junk tags', () => {
    expect(localeDisplayName('fr')).toBe('French')
    expect(localeDisplayName('fr', 'fr')).toBe('français')
    expect(localeDisplayName('not a tag !')).toBe('not a tag !')
  })
})
