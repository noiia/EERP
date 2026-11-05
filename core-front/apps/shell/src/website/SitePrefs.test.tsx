import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useI18nStore } from '@eerp/core-front'

const saveSitePreferences = vi.hoisted(() => vi.fn())
vi.mock('./site-preferences-actions', () => ({ saveSitePreferences }))

import { SiteFooterPrefs, SitePrefsSync } from './SitePrefs'
import { sitePrefsStore } from './site-prefs-store'

const localization = { default_locale: 'fr', default_currency: 'EUR', base: 'EUR', rates: { USD: 1.1 }, currencies: ['EUR', 'USD'], date_format: 'dd/MM/yyyy' }

beforeEach(() => {
  saveSitePreferences.mockReset().mockResolvedValue(undefined)
  act(() => {
    useI18nStore.getState().setLocale(null)
    sitePrefsStore.set({ base: 'EUR', rates: {}, currency: 'EUR', dateFormat: null })
  })
})

describe('SitePrefsSync', () => {
  it('applies the resolved language and currency to the client stores', () => {
    render(<SitePrefsSync prefs={{ locale: 'fr', currency: 'USD' }} localization={localization} />)
    expect(useI18nStore.getState().locale).toBe('fr')
    expect(sitePrefsStore.get()).toMatchObject({ base: 'EUR', currency: 'USD', rates: { USD: 1.1 }, dateFormat: 'dd/MM/yyyy' })
  })

  it('keeps the source language, and no date pattern when none is set', () => {
    act(() => useI18nStore.getState().setLocale('fr'))
    render(<SitePrefsSync prefs={{ locale: null, currency: 'EUR' }} localization={{ ...localization, date_format: '' }} />)
    expect(useI18nStore.getState().locale).toBeNull()
    expect(sitePrefsStore.get().dateFormat).toBeNull()
  })
})

describe('SiteFooterPrefs', () => {
  it('renders nothing with a single currency and no translation', () => {
    const { container } = render(<SiteFooterPrefs locales={[]} currencies={['EUR']} />)
    expect(container.innerHTML).toBe('')
  })

  it('a language pick applies at once and is kept', async () => {
    render(<SiteFooterPrefs locales={['fr']} currencies={['EUR']} />)
    expect(screen.queryByLabelText('Currency')).toBeNull()
    fireEvent.mouseDown(screen.getByLabelText('Language'))
    fireEvent.click(await screen.findByRole('option', { name: /fran/i }))
    expect(useI18nStore.getState().locale).toBe('fr')
    expect(saveSitePreferences).toHaveBeenCalledWith('fr', 'EUR')
    fireEvent.mouseDown(screen.getByRole('combobox'))
    fireEvent.click(await screen.findByRole('option', { name: /English|anglais/i }))
    expect(useI18nStore.getState().locale).toBeNull()
    expect(saveSitePreferences).toHaveBeenLastCalledWith(null, 'EUR')
  })

  it('a currency pick applies at once and is kept; an unknown current one shows the first', async () => {
    act(() => sitePrefsStore.set({ currency: 'JPY' }))
    render(<SiteFooterPrefs locales={[]} currencies={['EUR', 'USD']} />)
    expect(screen.getByLabelText('Currency').textContent).toBe('EUR')
    fireEvent.mouseDown(screen.getByLabelText('Currency'))
    fireEvent.click(await screen.findByRole('option', { name: 'USD' }))
    expect(sitePrefsStore.get().currency).toBe('USD')
    expect(saveSitePreferences).toHaveBeenCalledWith(null, 'USD')
  })
})
