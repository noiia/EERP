'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Container from '@mui/material/Container'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { localeDisplayName, translationRegistry, useI18nStore, useT } from '@eerp/core-front'
// Catalogs register as an import side effect; the selector needs the pool populated.
import '@/generated/generated-translations'
import { resolveEffectiveLocale, SOURCE_PREFERENCE, type LocalePreferences } from '@/lib/locale'
import { setMyPreferredLocale } from '@/lib/preferences'

// Settings → Account: the caller's personal preferences. The display language is
// server state on the user record (PUT /me/preferences), so it follows the account
// across browsers; the client i18n store is only its local mirror, updated
// optimistically here and reconciled by LocaleSync on the next load. Three kinds of
// value: inherit the workspace default (null), force the source language ("source"),
// or a concrete locale tag.

/** The Select value standing for "inherit the workspace default". */
const DEFAULT_VALUE = 'default'

export default function AccountSettings({
  preferences,
}: {
  /** Server-read preferences; null when the read failed (select renders read-only). */
  preferences: LocalePreferences | null
}) {
  const t = useT()
  const enabledLocales = useI18nStore((s) => s.enabledLocales)
  const addLocale = useI18nStore((s) => s.addLocale)
  const setLocale = useI18nStore((s) => s.setLocale)
  const [preferred, setPreferred] = useState(preferences?.preferred_locale ?? null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const defaultLocale = preferences?.default_locale ?? null
  const pool = translationRegistry.locales().map((info) => info.locale)
  // Offered languages: what the user enabled in Settings → Translations, plus the
  // current preference itself so a choice made elsewhere never disappears from view.
  const offered = pool.filter((locale) => enabledLocales.includes(locale) || locale === preferred)

  const selectValue =
    preferred === null ? DEFAULT_VALUE : offered.includes(preferred) ? preferred : SOURCE_PREFERENCE
  const defaultLabel = defaultLocale
    ? localeDisplayName(defaultLocale, defaultLocale)
    : t('English (source)')

  async function onChange(value: string) {
    const next = value === DEFAULT_VALUE ? null : value
    const previous = preferred
    setPreferred(next)
    setSaving(true)
    const result = await setMyPreferredLocale(next)
    setSaving(false)
    if (!result.ok) {
      setPreferred(previous)
      setError(result.message)
      return
    }
    setError(null)
    const effective = resolveEffectiveLocale(
      { preferred_locale: next, default_locale: defaultLocale },
      pool,
    )
    if (effective) addLocale(effective)
    setLocale(effective)
  }

  return (
    <Container maxWidth="md" sx={{ py: 6 }}>
      <Stack spacing={3}>
        <Stack spacing={1}>
          <Typography variant="h4" component="h1">
            {t('Account')}
          </Typography>
          <Typography color="text.secondary">
            {t('Your personal preferences. They follow your account on every device.')}
          </Typography>
        </Stack>

        <FormControl sx={{ maxWidth: 360 }} disabled={preferences === null || saving}>
          <InputLabel id="display-language-label">{t('Display language')}</InputLabel>
          <Select
            labelId="display-language-label"
            label={t('Display language')}
            value={selectValue}
            onChange={(e) => void onChange(e.target.value)}
          >
            <MenuItem value={DEFAULT_VALUE}>
              {t('Workspace default')} — {defaultLabel}
            </MenuItem>
            <MenuItem value={SOURCE_PREFERENCE}>{t('English (source)')}</MenuItem>
            {offered.map((locale) => (
              <MenuItem key={locale} value={locale}>
                {localeDisplayName(locale, locale)}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Typography variant="body2" color="text.secondary">
          {t(
            'Languages come from the translations enabled in Settings → Translations. "Workspace default" follows whatever the workspace administrator picks.',
          )}
        </Typography>

        {preferences === null && (
          <Alert severity="warning">
            {t('Your preferences could not be loaded — try reloading the page.')}
          </Alert>
        )}
        {error && <Alert severity="error">{error}</Alert>}
      </Stack>
    </Container>
  )
}
