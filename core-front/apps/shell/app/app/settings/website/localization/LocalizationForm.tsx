'use client'
import { useState } from 'react'
import Button from '@mui/material/Button'
import IconButton from '@mui/material/IconButton'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { localeDisplayName, translationRegistry, useT, ViewBanner } from '@eerp/core-front'
import { saveWebsiteLocalization, type WebsiteLocalizationView } from '@/lib/website-settings'

/** Offered currencies whose hand-set rate is below the live one: the site would
 * show (and a visitor compare) a lower price than the market conversion. */
export function underpricedCurrencies(l: Pick<WebsiteLocalizationView, 'currencies' | 'overrides' | 'live'>): string[] {
  return l.currencies.filter((c) => l.overrides[c] != null && l.live[c] != null && l.overrides[c] < l.live[c])
}

const SOURCE = ''

const without = (o: Record<string, number>, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key))

export default function LocalizationForm({ initial }: { initial: WebsiteLocalizationView }) {
  const t = useT()
  const [l, setL] = useState(initial)
  const [adding, setAdding] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const locales = translationRegistry.locales().map((i) => i.locale)
  const underpriced = underpricedCurrencies(l)

  function add() {
    const code = adding.trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(code) || code === l.base || l.currencies.includes(code)) return
    setL({ ...l, currencies: [...l.currencies, code] })
    setAdding('')
  }
  function remove(code: string) {
    const overrides = without(l.overrides, code)
    setL({ ...l, currencies: l.currencies.filter((c) => c !== code), overrides, default_currency: l.default_currency === code ? '' : l.default_currency })
  }
  function setOverride(code: string, raw: string) {
    const overrides = without(l.overrides, code)
    const v = Number(raw.replace(',', '.'))
    setL({ ...l, overrides: raw.trim() === '' || !(v > 0) ? overrides : { ...overrides, [code]: v } })
  }
  async function save() {
    const res = await saveWebsiteLocalization({
      default_locale: l.default_locale, default_currency: l.default_currency, currencies: l.currencies, overrides: l.overrides,
    })
    setMsg(res.ok ? { ok: true, text: t('Saved.') } : { ok: false, text: res.message || t('Could not save.') })
  }

  return (
    <Stack spacing={3} sx={{ maxWidth: 640 }}>
      <Typography color="text.secondary">
        {t('What a first-time visitor sees. Visitors can change both in the website footer; an account keeps its own choice.')}
      </Typography>
      <TextField select label={t('Default language')} value={l.default_locale} onChange={(e) => setL({ ...l, default_locale: e.target.value })}>
        <MenuItem value={SOURCE}>{localeDisplayName('en', 'en')}</MenuItem>
        {locales.map((c) => <MenuItem key={c} value={c}>{localeDisplayName(c, c)}</MenuItem>)}
      </TextField>

      <Stack spacing={1.5}>
        <Typography variant="h6" component="h2">{t('Currencies')}</Typography>
        <Typography variant="body2" color="text.secondary">
          {t('Prices are stored in the workspace currency; other currencies are converted for display only, at the live rate (European Central Bank) unless you set one. Bookings are still charged in the workspace currency.')}
        </Typography>
        <Typography>{t('Workspace currency')}: <strong>{l.base || '—'}</strong></Typography>
        {l.currencies.map((code) => (
          <Stack key={code} direction="row" spacing={2} sx={{ alignItems: 'center' }}>
            <Typography sx={{ width: 48, fontWeight: 600 }}>{code}</Typography>
            <TextField
              size="small"
              label={`${t('Rate')}: 1 ${l.base} =`}
              placeholder={l.live[code] != null ? String(Number(l.live[code].toFixed(6))) : t('No live rate')}
              defaultValue={l.overrides[code] ?? ''}
              onChange={(e) => setOverride(code, e.target.value)}
              helperText={l.live[code] != null ? `${t('Live rate')}: ${Number(l.live[code].toFixed(6))}` : t('No live rate: set one, or the currency is not offered.')}
              slotProps={{ htmlInput: { inputMode: 'decimal' } }}
            />
            <IconButton aria-label={t('Remove')} onClick={() => remove(code)}>×</IconButton>
          </Stack>
        ))}
        <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
          <TextField size="small" label={t('Add a currency (ISO code)')} placeholder="USD" value={adding}
            onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
            slotProps={{ htmlInput: { maxLength: 3 } }} />
          <Button onClick={add}>{t('Add')}</Button>
        </Stack>
        {underpriced.length > 0 && (
          <ViewBanner status="warning">
            {t('The rate you set is below the live rate, so prices show lower than their market conversion:')} {underpriced.join(', ')}
          </ViewBanner>
        )}
      </Stack>

      <TextField select label={t('Default currency')} value={l.default_currency || l.base} onChange={(e) => setL({ ...l, default_currency: e.target.value === l.base ? '' : e.target.value })}>
        {[l.base, ...l.currencies].filter(Boolean).map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
      </TextField>

      <Button variant="contained" onClick={() => void save()} sx={{ alignSelf: 'flex-start' }}>{t('Save')}</Button>
      {msg && <ViewBanner status={msg.ok ? 'info' : 'error'}>{msg.text}</ViewBanner>}
    </Stack>
  )
}
