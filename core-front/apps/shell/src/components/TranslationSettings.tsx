'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Card from '@mui/material/Card'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import Container from '@mui/material/Container'
import Divider from '@mui/material/Divider'
import FormControl from '@mui/material/FormControl'
import InputLabel from '@mui/material/InputLabel'
import ListItemText from '@mui/material/ListItemText'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import {
  localeDisplayName,
  renderModulePo,
  translationRegistry,
  useI18nStore,
  useT,
  type LocaleInfo,
} from '@eerp/core-front'
// Catalogs register as an import side effect; importing here (not only in the layout)
// guarantees the registry is populated before this page lists it.
import '@/generated/generated-translations'
import { setDefaultLocale as saveDefaultLocale } from '@/lib/preferences'

// Settings → Translations: the workspace-level language manager. The POOL of
// translations is fixed at build time — whatever the modules ship in their i18n/
// folders as .po files — and the add/remove SELECTION lives client-side in the
// persisted useI18nStore. The DEFAULT LANGUAGE is workspace state: it persists
// server-side (PUT /settings/i18n, permission settings:i18n:write) and applies to
// every user who has not chosen a personal display language — that per-user choice
// lives under Settings → Account.

/** The Select value standing for the source language (MUI wants a non-null value). */
const SOURCE_VALUE = 'source'

/**
 * Target languages always offered by the export selector, on top of whatever locales
 * the modules already ship — so a brand-new translation can start from a blank export.
 */
const EXPORT_LOCALE_SUGGESTIONS = ['de', 'en', 'es', 'fr', 'it', 'ja', 'nl', 'pl', 'pt', 'zh']

/** Trigger a browser download of a generated text file. */
function downloadTextFile(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function LocaleRow({ info, enabled }: { info: LocaleInfo; enabled: boolean }) {
  const t = useT()
  const addLocale = useI18nStore((s) => s.addLocale)
  const removeLocale = useI18nStore((s) => s.removeLocale)
  const coverage =
    info.total > 0 ? `${info.translated} / ${info.total} ${t('strings')}` : `${info.translated} ${t('strings')}`

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', py: 1.5 }}>
      <Box sx={{ flex: 1, minWidth: 200 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="subtitle1">{localeDisplayName(info.locale, info.locale)}</Typography>
          <Chip label={info.locale} size="small" variant="outlined" />
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {coverage} · {t('from')}{' '}
          {info.modules.join(', ')}
        </Typography>
      </Box>
      {enabled ? (
        <Button
          variant="outlined"
          color="inherit"
          onClick={() => removeLocale(info.locale)}
          aria-label={`Remove ${info.locale}`}
        >
          {t('Remove')}
        </Button>
      ) : (
        <Button
          variant="contained"
          onClick={() => addLocale(info.locale)}
          aria-label={`Add ${info.locale}`}
        >
          {t('Add')}
        </Button>
      )}
    </Box>
  )
}

/**
 * Export one gettext .po per module for a chosen target language: every string the
 * module declares translatable (its .pot template + already-translated msgids), with
 * msgstrs pre-filled from that language's existing catalog and blank otherwise. The
 * downloaded file is drop-in ready: saved as i18n/<locale>.po in the module folder,
 * the next build ships it — this is how a new language starts.
 */
function ExportSection() {
  const t = useT()
  const activeLocale = useI18nStore((s) => s.locale)
  const discovered = translationRegistry.locales().map((info) => info.locale)
  const options = [...new Set([...discovered, ...EXPORT_LOCALE_SUGGESTIONS])].sort()
  // Only modules that actually declare translatable strings are offered; all of them
  // are pre-selected — narrowing down is the exception, one file per module the rule.
  const exportableModules = translationRegistry
    .modules()
    .filter((module) => translationRegistry.moduleKeys(module).length > 0)
  const [selectedModules, setSelectedModules] = useState(exportableModules)
  const [target, setTarget] = useState(activeLocale ?? discovered[0] ?? 'fr')

  function onExport() {
    for (const module of selectedModules) {
      const po = renderModulePo(translationRegistry, module, target)
      if (po) downloadTextFile(`${module}-${target}.po`, po)
    }
  }

  return (
    <Stack spacing={2}>
      <Stack spacing={1}>
        <Typography variant="h6" component="h2">
          {t('Export translation files')}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t(
            'Download one .po file per selected module with every translatable string, pre-filled with the existing translations for the target language. Save each file as i18n/<locale>.po inside its module folder and rebuild.',
          )}
        </Typography>
      </Stack>
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        <FormControl sx={{ minWidth: 220 }}>
          <InputLabel id="export-modules-label">{t('Modules')}</InputLabel>
          <Select
            multiple
            labelId="export-modules-label"
            label={t('Modules')}
            value={selectedModules}
            onChange={(e) => {
              const value = e.target.value
              setSelectedModules(typeof value === 'string' ? value.split(',') : value)
            }}
            renderValue={(selected) => selected.join(', ')}
          >
            {exportableModules.map((module) => (
              <MenuItem key={module} value={module}>
                <Checkbox checked={selectedModules.includes(module)} size="small" />
                <ListItemText primary={module} />
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControl sx={{ minWidth: 220 }}>
          <InputLabel id="export-language-label">{t('Target language')}</InputLabel>
          <Select
            labelId="export-language-label"
            label={t('Target language')}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            {options.map((tag) => (
              <MenuItem key={tag} value={tag}>
                {localeDisplayName(tag, tag)} ({tag})
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Button variant="contained" onClick={onExport} disabled={selectedModules.length === 0}>
          {t('Export')}
        </Button>
      </Box>
    </Stack>
  )
}

export interface TranslationSettingsProps {
  /**
   * The caller's own preferred_locale (null = inherits the workspace default,
   * undefined = unknown because the preferences read failed). Used to reflect a
   * default-language change immediately for callers who inherit it.
   */
  preferredLocale?: string | null
  /** The current workspace default locale (null/undefined = source language). */
  defaultLocale?: string | null
  /** Whether the caller holds settings:i18n:write (the page resolves it server-side). */
  canEditDefault?: boolean
}

/**
 * The workspace default language: server-persisted, applied to every user without a
 * personal preference. The save is optimistic — reverted with the backend's error
 * message when it fails (e.g. the permission was revoked since the page rendered).
 */
function DefaultLanguageSection({
  preferredLocale,
  defaultLocale,
  canEditDefault,
}: TranslationSettingsProps) {
  const t = useT()
  const addLocale = useI18nStore((s) => s.addLocale)
  const setLocale = useI18nStore((s) => s.setLocale)
  const [saved, setSaved] = useState(defaultLocale ?? null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pool = translationRegistry.locales()
  const selectValue = pool.some((info) => info.locale === saved) ? (saved as string) : SOURCE_VALUE

  async function onChange(value: string) {
    const next = value === SOURCE_VALUE ? null : value
    const previous = saved
    setSaved(next)
    setSaving(true)
    const result = await saveDefaultLocale(next)
    setSaving(false)
    if (!result.ok) {
      setSaved(previous)
      setError(result.message)
      return
    }
    setError(null)
    // Callers without a personal choice inherit the default — reflect it now
    // instead of on the next full load.
    if (preferredLocale === null) {
      if (next) addLocale(next)
      setLocale(next)
    }
  }

  return (
    <Stack spacing={2}>
      <FormControl sx={{ maxWidth: 320 }} disabled={!canEditDefault || saving}>
        <InputLabel id="default-language-label">{t('Default language')}</InputLabel>
        <Select
          labelId="default-language-label"
          label={t('Default language')}
          value={selectValue}
          onChange={(e) => void onChange(e.target.value)}
        >
          <MenuItem value={SOURCE_VALUE}>{t('English (source)')}</MenuItem>
          {pool.map((info) => (
            <MenuItem key={info.locale} value={info.locale}>
              {localeDisplayName(info.locale, info.locale)}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <Typography variant="body2" color="text.secondary">
        {canEditDefault
          ? t(
              'The interface language for every user who has not picked one in Settings → Account.',
            )
          : t('Changing the workspace default language requires the settings:i18n:write permission.')}
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  )
}

export default function TranslationSettings({
  preferredLocale,
  defaultLocale,
  canEditDefault = false,
}: TranslationSettingsProps = {}) {
  const t = useT()
  const enabledLocales = useI18nStore((s) => s.enabledLocales)

  // The build-time pool. Persisted enabled state may reference locales whose .po
  // files are gone since the last build — they simply stop being offered.
  const available = translationRegistry.locales()

  return (
    <Container maxWidth="md" sx={{ py: 6 }}>
      <Stack spacing={3}>
        <Stack spacing={1}>
          <Typography variant="h4" component="h1">
            {t('Translations')}
          </Typography>
          <Typography color="text.secondary">
            {t(
              'Choose the workspace default language and manage the translations installed modules provide.',
            )}
          </Typography>
        </Stack>

        <DefaultLanguageSection
          preferredLocale={preferredLocale}
          defaultLocale={defaultLocale}
          canEditDefault={canEditDefault}
        />

        <Divider />

        <Stack spacing={1}>
          <Typography variant="h6" component="h2">
            {t('Available translations')}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t(
              'Discovered from the i18n folder of each module (.po files, one per language). Add a translation to offer it as a display language in Settings → Account.',
            )}
          </Typography>
        </Stack>

        {available.length === 0 ? (
          <Card variant="outlined" sx={{ p: 3 }}>
            <Typography color="text.secondary">
              {t('No translations found. Modules ship them as i18n/<locale>.po files.')}
            </Typography>
          </Card>
        ) : (
          <Card variant="outlined" sx={{ px: 2 }}>
            <Stack divider={<Divider />}>
              {available.map((info) => (
                <LocaleRow
                  key={info.locale}
                  info={info}
                  enabled={enabledLocales.includes(info.locale)}
                />
              ))}
            </Stack>
          </Card>
        )}

        <Divider />

        <ExportSection />
      </Stack>
    </Container>
  )
}
