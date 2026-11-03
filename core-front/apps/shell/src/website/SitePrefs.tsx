'use client'
import { useEffect, useTransition } from 'react'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import { localeDisplayName, useI18nStore, useT } from '@eerp/core-front'
import type { SiteLocalization } from './public-api'
import { saveSitePreferences } from './site-preferences-actions'
import { SOURCE_LOCALE_VALUE, type SitePrefs } from './site-prefs'
import { sitePrefsStore, useSitePrefs } from './site-prefs-store'

/** Applies the visitor's resolved language and currency to the client stores the
 * blocks render from. Mounted by the site layout, below the root's LocaleSync, so
 * on site pages the visitor's language wins over an ERP session's. */
export function SitePrefsSync({ prefs, localization }: { prefs: SitePrefs; localization: SiteLocalization }) {
  useEffect(() => {
    const i18n = useI18nStore.getState()
    if (prefs.locale) i18n.addLocale(prefs.locale)
    if (i18n.locale !== prefs.locale) i18n.setLocale(prefs.locale)
    sitePrefsStore.set({
      base: localization.base,
      rates: localization.rates,
      currency: prefs.currency,
      dateFormat: localization.date_format || null,
    })
  }, [prefs, localization])
  return null
}

/** The footer's language and currency pickers. A pick applies at once and is kept
 * (cookie, and the account when signed in). */
export function SiteFooterPrefs({ locales, currencies }: { locales: string[]; currencies: string[] }) {
  const t = useT()
  const locale = useI18nStore((s) => s.locale)
  const { currency } = useSitePrefs()
  const [, startTransition] = useTransition()

  function save(nextLocale: string | null, nextCurrency: string) {
    startTransition(() => void saveSitePreferences(nextLocale, nextCurrency))
  }
  function pickLocale(value: string) {
    const next = value === SOURCE_LOCALE_VALUE ? null : value
    const i18n = useI18nStore.getState()
    if (next) i18n.addLocale(next)
    i18n.setLocale(next)
    save(next, currency)
  }
  function pickCurrency(value: string) {
    sitePrefsStore.set({ currency: value })
    save(locale, value)
  }

  const showLocales = locales.length > 0
  const showCurrencies = currencies.length > 1
  if (!showLocales && !showCurrencies) return null
  const field = { size: 'small', variant: 'standard', sx: { minWidth: 120 } } as const
  return (
    <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
      {showLocales && (
        <TextField select {...field} label={t('Language')} value={locale ?? SOURCE_LOCALE_VALUE} onChange={(e) => pickLocale(e.target.value)}>
          <MenuItem value={SOURCE_LOCALE_VALUE}>{localeDisplayName('en', 'en')}</MenuItem>
          {locales.map((l) => <MenuItem key={l} value={l}>{localeDisplayName(l, l)}</MenuItem>)}
        </TextField>
      )}
      {showCurrencies && (
        <TextField select {...field} label={t('Currency')} value={currencies.includes(currency) ? currency : currencies[0]} onChange={(e) => pickCurrency(e.target.value)}>
          {currencies.map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
        </TextField>
      )}
    </Stack>
  )
}
