import { beforeEach, describe, expect, it } from 'vitest'
import { SOURCE_LOCALE, useI18nStore } from './i18n-store'

describe('useI18nStore', () => {
  beforeEach(() => {
    useI18nStore.setState({ locale: SOURCE_LOCALE, enabledLocales: [] })
  })

  it('defaults to the source language with no translations enabled', () => {
    expect(useI18nStore.getState().locale).toBeNull()
    expect(useI18nStore.getState().enabledLocales).toEqual([])
  })

  it('addLocale is idempotent', () => {
    useI18nStore.getState().addLocale('fr')
    useI18nStore.getState().addLocale('fr')
    expect(useI18nStore.getState().enabledLocales).toEqual(['fr'])
  })

  it('setLocale activates a language and back to source', () => {
    useI18nStore.getState().setLocale('fr')
    expect(useI18nStore.getState().locale).toBe('fr')
    useI18nStore.getState().setLocale(SOURCE_LOCALE)
    expect(useI18nStore.getState().locale).toBeNull()
  })

  it('removing the active locale falls back to the source language', () => {
    useI18nStore.getState().addLocale('fr')
    useI18nStore.getState().setLocale('fr')
    useI18nStore.getState().removeLocale('fr')
    expect(useI18nStore.getState().enabledLocales).toEqual([])
    expect(useI18nStore.getState().locale).toBeNull()
  })

  it('removing an inactive locale keeps the active one', () => {
    useI18nStore.getState().addLocale('fr')
    useI18nStore.getState().addLocale('de')
    useI18nStore.getState().setLocale('fr')
    useI18nStore.getState().removeLocale('de')
    expect(useI18nStore.getState().enabledLocales).toEqual(['fr'])
    expect(useI18nStore.getState().locale).toBe('fr')
  })
})
