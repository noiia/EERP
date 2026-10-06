'use client'
import { useState } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { HtmlEditor, useT } from '@eerp/core-front'
import { resetMailTemplate, saveMailTemplate, type MailTemplate, type TemplateContent } from '@/lib/mail-templates'

/** The text a (template, language) sends today: the override, else the default
 * of that language, its base language, or English — Go's own fallback order. */
function effective(tpl: MailTemplate, locale: string): TemplateContent {
  const base = locale.split('-')[0]
  return tpl.overrides[locale] ?? tpl.defaults[locale] ?? tpl.defaults[base] ?? tpl.defaults.en
}

/** Settings → Email templates: pick an email and a language, edit its subject and
 * body; Save stores a workspace override (Go sanitizes it and refuses unknown
 * variables), Reset to default drops it. */
export default function EmailTemplatesForm({ templates, canEdit }: { templates: MailTemplate[]; canEdit: boolean }) {
  const t = useT()
  const [all, setAll] = useState(templates)
  const [key, setKey] = useState(templates[0]?.key ?? '')
  const [locale, setLocale] = useState('en')
  const tpl = all.find((x) => x.key === key)
  const [draft, setDraft] = useState<TemplateContent>(() => (tpl ? effective(tpl, locale) : { subject: '', html: '' }))
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  if (!tpl) return <Typography color="text.secondary">{t('No email templates are registered.')}</Typography>

  const locales = [...new Set(['en', ...Object.keys(tpl.defaults), ...Object.keys(tpl.overrides)])].sort()
  const customized = locale in tpl.overrides
  const pick = (nextKey: string, nextLocale: string) => {
    const next = all.find((x) => x.key === nextKey)!
    setKey(nextKey)
    setLocale(nextLocale)
    setDraft(effective(next, nextLocale))
    setMsg(null)
  }
  const setOverride = (content: TemplateContent | null) =>
    setAll((list) => list.map((x) => {
      if (x.key !== key) return x
      const overrides = { ...x.overrides }
      if (content) overrides[locale] = content
      else delete overrides[locale]
      return { ...x, overrides }
    }))

  async function save() {
    const res = await saveMailTemplate(key, locale, draft)
    if (res.ok) setOverride(draft)
    setMsg(res.ok ? { ok: true, text: t('Saved.') } : { ok: false, text: res.message || t('Could not save.') })
  }
  async function reset() {
    const res = await resetMailTemplate(key, locale)
    if (!res.ok) return setMsg({ ok: false, text: t('Could not save.') })
    setOverride(null)
    const base = locale.split('-')[0]
    setDraft(tpl!.defaults[locale] ?? tpl!.defaults[base] ?? tpl!.defaults.en)
    setMsg({ ok: true, text: t('Back to the default text.') })
  }

  return (
    <Stack spacing={2} sx={{ maxWidth: 820 }}>
      <Stack direction="row" spacing={2}>
        <TextField select id="mail-template-key" label={t('Email')} value={key} sx={{ minWidth: 280 }}
          onChange={(e) => pick(e.target.value, locale)}>
          {all.map((x) => <MenuItem key={x.key} value={x.key}>{t(x.label)}</MenuItem>)}
        </TextField>
        <TextField select id="mail-template-locale" label={t('Language')} value={locale} sx={{ minWidth: 120 }}
          onChange={(e) => pick(key, e.target.value)}>
          {locales.map((l) => <MenuItem key={l} value={l}>{l}</MenuItem>)}
        </TextField>
        <Chip sx={{ alignSelf: 'center' }} size="small" color={customized ? 'primary' : 'default'}
          label={customized ? t('Customized') : t('Default text')} />
      </Stack>
      <TextField id="mail-template-subject" label={t('Subject')} value={draft.subject} disabled={!canEdit}
        onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
      <HtmlEditor value={draft.html} disabled={!canEdit} onChange={(html) => setDraft((d) => ({ ...d, html }))}
        insertions={tpl.vars.map((v) => `{{${v}}}`)} />
      <Typography variant="caption" color="text.secondary">
        {t('Click a variable to insert it; it is replaced by the real value in each email. The plain-text version is built from this text.')}
      </Typography>
      {canEdit && (
        <Stack direction="row" spacing={1}>
          <Button variant="contained" onClick={() => void save()}>{t('Save')}</Button>
          {customized && <Button variant="outlined" onClick={() => void reset()}>{t('Reset to default')}</Button>}
        </Stack>
      )}
      {msg && <Alert severity={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
    </Stack>
  )
}
