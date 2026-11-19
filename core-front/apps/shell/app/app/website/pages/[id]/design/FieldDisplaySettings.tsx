'use client'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import InputAdornment from '@mui/material/InputAdornment'
import List from '@mui/material/List'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemText from '@mui/material/ListItemText'
import MenuItem from '@mui/material/MenuItem'
import Skeleton from '@mui/material/Skeleton'
import Stack from '@mui/material/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { byPrefixAndName, FontAwesomeIcon, useT } from '@eerp/core-front'
import { FieldLines, SiteIcon } from '@/website/blocks/FieldValue'
import { describeFields, previewField, searchFieldIcons, type FieldInfo, type FieldPreview } from '@/website/field-display-actions'
import {
  FIELD_KINDS, humanize, resolveDisplay, withFieldDisplay,
  type DateStyle, type FieldDisplay, type FieldDisplays, type FieldFormat, type FieldIcon, type FieldKind, type IconColor, type IconSpacing,
} from '@/website/field-display'
import type { SiteIconData } from '@/website/field-icons'
import { SiteTheme } from '@/website/SiteTheme'
import { InspectorSection } from './Inspector'

// The builder's field display settings (ADR-036): per shown field, its label, its
// formatting (adapted to what the field holds) and an optional Font Awesome Free icon,
// with a live preview of a real published value drawn in the site's own theme.

export const KIND_LABELS: Record<FieldKind, string> = {
  text: 'Text', multiline: 'Long text', email: 'Email', url: 'Web address', phone: 'Phone', monetary: 'Amount',
  integer: 'Whole number', decimal: 'Decimal number', percent: 'Percentage', rating: 'Rating', duration: 'Duration',
  boolean: 'Yes / no', date: 'Date', datetime: 'Date and time', selection: 'Choice', relation: 'Linked record', color: 'Color',
}

/** The block's shown fields, each opening its display settings. */
export function FieldDisplayList({ table, fields, displays, columns, onChange }: {
  table: string
  /** The shown fields, in their order (the title field excluded). */
  fields: string[]
  displays: FieldDisplays | undefined
  /** Every declared column of the table (a monetary field may take its currency from one). */
  columns: string[]
  onChange: (next: FieldDisplays) => void
}) {
  const t = useT()
  const [infos, setInfos] = useState<Record<string, FieldInfo>>({})
  const [open, setOpen] = useState<string | null>(null)
  const key = fields.join(',')
  useEffect(() => {
    let live = true
    if (table && key) void describeFields(table, key.split(',')).then((i) => live && setInfos(i), () => {})
    return () => { live = false }
  }, [table, key])
  if (!table || fields.length === 0) return null
  return (
    <>
      <List dense disablePadding aria-label={t('Field display')} sx={{ mx: -1 }}>
        {fields.map((f) => {
          const d = resolveDisplay(displays, f)
          const kind = d.format.as && d.format.as !== 'auto' ? d.format.as : infos[f]?.kind
          const label = d.hideLabel ? t('Label hidden') : d.customLabel || humanize(f)
          const details = [kind && t(KIND_LABELS[kind]), d.icon && t('with an icon')].filter(Boolean).join(', ')
          return (
            <ListItemButton key={f} onClick={() => setOpen(f)} sx={{ borderRadius: 1, py: 0.25 }} aria-label={`${t('Display settings')}: ${f}`}>
              <ListItemText
                primary={<><Box component="span" sx={{ fontStyle: d.hideLabel ? 'italic' : undefined, color: d.hideLabel ? 'text.secondary' : undefined }}>{label}</Box>
                  <Box component="span" sx={{ color: 'text.secondary', ml: 0.75, fontSize: '0.75rem' }}>{f}</Box></>}
                secondary={details || undefined}
              />
              <Box component="span" aria-hidden sx={{ color: 'text.secondary', fontSize: 12, ml: 1 }}><FontAwesomeIcon icon={byPrefixAndName.fas.pen} /></Box>
            </ListItemButton>
          )
        })}
      </List>
      {open && (
        <FieldDisplayDialog
          table={table} field={open} info={infos[open]} columns={columns}
          display={(displays ?? {})[open] ?? {}}
          onClose={() => setOpen(null)}
          onSave={(next) => { onChange(withFieldDisplay(displays, open, next)); setOpen(null) }}
        />
      )}
    </>
  )
}

const currencies = (() => {
  try { return Intl.supportedValuesOf('currency') } catch { return ['EUR', 'USD', 'GBP', 'CHF'] }
})()
const timeZones = (() => {
  try { return Intl.supportedValuesOf('timeZone') } catch { return ['UTC'] }
})()

function regionName(code: string, locale: string): string | undefined {
  try { return new Intl.DisplayNames([locale], { type: 'region' }).of(code) } catch { return undefined }
}
function currencyName(code: string, locale: string): string {
  try { return new Intl.DisplayNames([locale], { type: 'currency' }).of(code) ?? code } catch { return code }
}

export function FieldDisplayDialog({ table, field, info, display, columns, onSave, onClose }: {
  table: string
  field: string
  info: FieldInfo | undefined
  display: FieldDisplay
  columns: string[]
  onSave: (next: FieldDisplay | null) => void
  onClose: () => void
}) {
  const t = useT()
  const uiLocale = typeof navigator === 'undefined' ? 'en' : navigator.language
  const [draft, setDraft] = useState<FieldDisplay>(display)
  const format = draft.format ?? {}
  const autoKind = info?.kind ?? 'text'
  const kind: FieldKind = format.as && format.as !== 'auto' ? format.as : autoKind
  const setFormat = (patch: Partial<FieldFormat>) => setDraft((d) => ({ ...d, format: { ...d.format, ...patch } }))
  const setIcon = (patch: Partial<FieldIcon> | null) => setDraft((d) => ({ ...d, icon: patch === null ? null : { ...(d.icon ?? { name: '' }), ...patch } }))
  const id = (k: string) => `field-display-${field}-${k}`

  // Live preview (debounced): a real published value when there is one.
  const [preview, setPreview] = useState<FieldPreview | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => void previewField(table, field, draft).then((p) => live && setPreview(p), () => live && setPreview(null)), 250)
    return () => { live = false; clearTimeout(timer) }
  }, [table, field, draft])

  const decimals = (
    <TextField id={id('decimals')} size="small" type="number" label={t('Decimals')} value={format.decimals ?? ''}
      helperText={t('Empty: automatic.')} slotProps={{ htmlInput: { min: 0, max: 6 } }}
      onChange={(e) => setFormat({ decimals: e.target.value === '' ? undefined : Math.min(Math.max(Number(e.target.value), 0), 6) })} />
  )
  const dateStyle = (
    <TextField id={id('date-style')} select size="small" label={t('Date style')} value={format.date_style ?? 'medium'}
      onChange={(e) => setFormat({ date_style: e.target.value as DateStyle })}>
      <MenuItem value="short">{t('Short (03/01/2026)')}</MenuItem>
      <MenuItem value="medium">{t('Medium (Mar 1, 2026)')}</MenuItem>
      <MenuItem value="long">{t('Long (March 1, 2026)')}</MenuItem>
    </TextField>
  )
  let kindSettings: ReactNode = null
  switch (kind) {
    case 'phone': {
      const code = (format.country ?? '').toUpperCase()
      kindSettings = (
        <TextField id={id('country')} size="small" label={t('Country of numbers without a +prefix')} value={code} placeholder="FR"
          error={!!code && !/^[A-Z]{2}$/.test(code)}
          helperText={code ? (regionName(code, uiLocale) ?? t('Not a country code (two letters, e.g. FR, US).')) : t('Empty: the country of the site’s default language. Numbers of another country are written internationally.')}
          slotProps={{ htmlInput: { maxLength: 2, style: { textTransform: 'uppercase' } } }}
          onChange={(e) => setFormat({ country: e.target.value.toUpperCase() || undefined })} />
      )
      break
    }
    case 'monetary':
      kindSettings = (
        <>
          <Autocomplete size="small" options={currencies} value={format.currency ?? null}
            getOptionLabel={(c) => `${c} — ${currencyName(c, uiLocale)}`}
            onChange={(_, c) => setFormat({ currency: c ?? undefined })}
            renderInput={(p) => <TextField {...p} id={id('currency')} label={t('Currency')} helperText={t('Empty: the workspace currency, converted for visitors who pick another one.')} />} />
          <TextField id={id('currency-field')} select size="small" label={t('Currency from a column')} value={format.currency_field ?? ''}
            helperText={t('For records that each store their own currency code.')}
            onChange={(e) => setFormat({ currency_field: e.target.value || undefined })}>
            <MenuItem value="">{t('None')}</MenuItem>
            {columns.filter((c) => c !== field).map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
          </TextField>
          {decimals}
        </>
      )
      break
    case 'integer': case 'decimal': case 'percent':
      kindSettings = decimals
      break
    case 'date':
      kindSettings = dateStyle
      break
    case 'datetime':
      kindSettings = (
        <>
          {dateStyle}
          <Autocomplete size="small" options={timeZones} value={format.timezone ?? null}
            onChange={(_, z) => setFormat({ timezone: z ?? undefined })}
            renderInput={(p) => <TextField {...p} id={id('timezone')} label={t('Time zone')} helperText={t('Empty: the server’s. The zone is always shown next to the time.')} />} />
        </>
      )
      break
    case 'boolean':
      kindSettings = (
        <Stack direction="row" spacing={1}>
          <TextField id={id('true')} size="small" label={t('When yes')} placeholder={t('Yes')} value={format.true_label ?? ''} onChange={(e) => setFormat({ true_label: e.target.value || undefined })} />
          <TextField id={id('false')} size="small" label={t('When no')} placeholder={t('No')} value={format.false_label ?? ''} onChange={(e) => setFormat({ false_label: e.target.value || undefined })} />
        </Stack>
      )
      break
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md" aria-labelledby={id('title')}>
      <DialogTitle id={id('title')} sx={{ pb: 1 }}>
        {t('Field display')}
        <Typography variant="body2" color="text.secondary">{field}</Typography>
      </DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) 300px' }, alignItems: 'start' }}>
          <Stack spacing={2.5} sx={{ pt: 1 }}>
            <InspectorSection title={t('Label')}>
              <TextField id={id('custom-label')} size="small" label={t('Custom label')} value={draft.custom_label ?? ''}
                placeholder={humanize(field)}
                helperText={info?.erpLabel && info.erpLabel !== humanize(field) ? `${t('In the ERP:')} ${t(info.erpLabel)}` : t('Empty: the column name.')}
                onChange={(e) => setDraft((d) => ({ ...d, custom_label: e.target.value }))} />
              <FormControlLabel label={t('Hide the label')}
                control={<Switch size="small" checked={!!draft.hide_label} onChange={(e) => setDraft((d) => ({ ...d, hide_label: e.target.checked }))} />} />
              {draft.hide_label && <Typography variant="caption" color="text.secondary">{t('Only the value shows. Screen readers still announce the label.')}</Typography>}
            </InspectorSection>
            <InspectorSection title={t('Format')}>
              <TextField id={id('as')} select size="small" label={t('Show as')} value={format.as ?? 'auto'}
                onChange={(e) => setFormat({ as: e.target.value as FieldKind | 'auto' })}>
                <MenuItem value="auto">{t('Automatic')} ({t(KIND_LABELS[autoKind])})</MenuItem>
                {FIELD_KINDS.filter((k) => k !== 'relation' || autoKind === 'relation').map((k) => <MenuItem key={k} value={k}>{t(KIND_LABELS[k])}</MenuItem>)}
              </TextField>
              {kindSettings}
            </InspectorSection>
            <InspectorSection title={t('Icon')}>
              <IconPicker kind={kind} icon={draft.icon ?? null} onPick={(icon) => setIcon(icon && { name: icon.name, family: icon.family })} />
              {draft.icon?.name && (
                <>
                  <Option label={t('Position')} value={draft.icon.position ?? 'before'} onChange={(v) => setIcon({ position: v as 'before' | 'after' })}
                    options={[['before', t('Before the value')], ['after', t('After the value')]]} />
                  <Option label={t('Spacing')} value={draft.icon.spacing ?? 'normal'} onChange={(v) => setIcon({ spacing: v as IconSpacing })}
                    options={[['tight', t('Tight')], ['normal', t('Normal')], ['loose', t('Loose')]]} />
                  <Option label={t('Color')} value={draft.icon.color ?? 'inherit'} onChange={(v) => setIcon({ color: v as IconColor })}
                    options={[['inherit', t('Like the text')], ['muted', t('Muted')], ['accent', t('Link color')]]} />
                </>
              )}
            </InspectorSection>
          </Stack>
          <Box sx={{ position: { md: 'sticky' }, top: 0 }}>
            <Typography variant="subtitle2" component="h3" sx={{ mb: 1, mt: 1 }}>{t('Preview')}</Typography>
            <SiteTheme sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2, minHeight: 64 }}>
              {preview === undefined ? <Skeleton width="80%" /> : preview?.value
                ? <FieldLines columns={[preview.column]} values={{ [field]: preview.value }} />
                : <Typography variant="body2" color="text.secondary">{t('Nothing to show for this field.')}</Typography>}
            </SiteTheme>
            {preview?.sample && <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>{t('A sample value: no published record has one yet.')}</Typography>}
          </Box>
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button color="inherit" onClick={() => onSave(null)} sx={{ mr: 'auto' }}>{t('Reset to automatic')}</Button>
        <Button onClick={onClose}>{t('Cancel')}</Button>
        <Button variant="contained" onClick={() => onSave(draft)}>{t('Apply')}</Button>
      </DialogActions>
    </Dialog>
  )
}

/** A small labelled toggle group (icon position, spacing, color). */
function Option({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <Stack spacing={0.5}>
      <Typography variant="caption" color="text.secondary" component="div">{label}</Typography>
      <ToggleButtonGroup size="small" exclusive value={value} aria-label={label} onChange={(_, v: string | null) => v && onChange(v)}>
        {options.map(([v, l]) => <ToggleButton key={v} value={v} sx={{ px: 1.5, py: 0.25, textTransform: 'none' }}>{l}</ToggleButton>)}
      </ToggleButtonGroup>
    </Stack>
  )
}

/** Searchable Font Awesome Free icons (Solid, Regular, Brands), drawn from the path data
 * the server sends — no icon set ships to the browser. */
function IconPicker({ kind, icon, onPick }: { kind: FieldKind; icon: FieldIcon | null; onPick: (icon: SiteIconData | null) => void }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SiteIconData[] | null>(null)
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => void searchFieldIcons(query, kind).then((r) => live && setResults(r), () => live && setResults([])), query ? 200 : 0)
    return () => { live = false; clearTimeout(timer) }
  }, [query, kind])
  const picked = useMemo(() => (icon?.name ? `${icon.family ?? 'solid'}:${icon.name}` : null), [icon])
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <TextField size="small" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Search icons (phone, mail, instagram…)')}
          sx={{ flex: 1 }} slotProps={{ htmlInput: { 'aria-label': t('Search icons') }, input: { startAdornment: <InputAdornment position="start"><FontAwesomeIcon icon={byPrefixAndName.fas['magnifying-glass']} /></InputAdornment> } }} />
        {picked && <Button size="small" color="inherit" onClick={() => onPick(null)}>{t('No icon')}</Button>}
      </Stack>
      <Box role="listbox" aria-label={t('Icons')} sx={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(40px, 1fr))', gap: 0.5,
        maxHeight: 168, overflowY: 'auto', p: 0.5, border: 1, borderColor: 'divider', borderRadius: 1,
      }}>
        {results === null && Array.from({ length: 12 }, (_, i) => <Skeleton key={i} variant="rounded" height={36} />)}
        {results?.length === 0 && <Typography variant="body2" color="text.secondary" sx={{ gridColumn: '1 / -1', p: 1 }}>{t('No icon matches.')}</Typography>}
        {results?.map((r) => {
          const on = picked === `${r.family}:${r.name}`
          return (
            <Tooltip key={`${r.family}:${r.name}`} title={`${r.name} (${t(r.family === 'solid' ? 'Solid' : r.family === 'regular' ? 'Regular' : 'Brands')})`}>
              <ButtonBase role="option" aria-selected={on} aria-label={`${r.name}, ${r.family}`} onClick={() => onPick(r)} sx={{
                height: 36, borderRadius: 1, fontSize: 16, color: on ? 'primary.contrastText' : 'text.primary', bgcolor: on ? 'primary.main' : 'transparent',
                '&:hover': { bgcolor: on ? 'primary.dark' : 'action.hover' }, '&.Mui-focusVisible': { outline: 2, outlineColor: 'primary.main' },
              }}>
                <SiteIcon data={r} />
              </ButtonBase>
            </Tooltip>
          )
        })}
      </Box>
      <Typography variant="caption" color="text.secondary">{t('Font Awesome Free icons. The icon is decorative: the label and value carry the meaning.')}</Typography>
    </Stack>
  )
}
