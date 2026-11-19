'use client'
import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import FormHelperText from '@mui/material/FormHelperText'
import FormLabel from '@mui/material/FormLabel'
import MenuItem from '@mui/material/MenuItem'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import { useT, ViewBanner } from '@eerp/core-front'
import { ADDRESS_SUFFIXES } from '../form-config'
import type { FormConfig, FormField } from '../types'
import { safeNext } from '../urls'

/** Field id → value: a string, a checkbox's boolean, or an address's parts. */
export type FormValues = Record<string, unknown>

const MIN_PASSWORD = 8 // Go's website signup rule
const ADDRESS_PARTS: { key: string; label: string; wide?: boolean }[] = [
  { key: 'number', label: 'Street number' }, { key: 'street', label: 'Street', wide: true }, { key: 'complement', label: 'Complement', wide: true },
  { key: 'zip_code', label: 'Zip code' }, { key: 'city', label: 'City' }, { key: 'state', label: 'State' }, { key: 'country', label: 'Country' },
]

type Status = { kind: 'idle' | 'submitting' | 'done' } | { kind: 'error'; message: string }

function isEmpty(f: FormField, v: unknown): boolean {
  if (f.type === 'checkbox') return v !== true
  if (f.type === 'address') {
    const a = (v ?? {}) as Record<string, unknown>
    return !String(a.street ?? '').trim() || !String(a.city ?? '').trim() // Go: street and city
  }
  return v == null || String(v).trim() === ''
}

/** What Go receives for a field: numbers as numbers, empty parts left out. */
function wire(f: FormField, v: unknown): unknown {
  if (f.type === 'checkbox') return v === true
  if (f.type === 'number') return v == null || String(v).trim() === '' ? null : Number(v)
  if (f.type === 'address') {
    const out: Record<string, unknown> = {}
    for (const s of ADDRESS_SUFFIXES) {
      const key = s.slice(1)
      const part = String((v as Record<string, unknown> | undefined)?.[key] ?? '').trim()
      if (part) out[key] = key === 'number' ? Number(part) : part
    }
    return out
  }
  return v == null ? '' : String(v)
}

/** The site's Form block, posting {values} to the BFF route /api/site-forms/:page/:block.
 * An anonymous visitor may tick "Create an account": the signup runs first (409 = an
 * error on the email field), then the form is sent as the new, signed-in visitor. */
export function SiteForm({ pageId, blockId, config, defaults = {}, signedIn = false, locked = [] }: {
  pageId: string
  blockId: string
  config: FormConfig
  defaults?: FormValues
  signedIn?: boolean
  /** Field ids shown read-only (a signed-in visitor's own email). */
  locked?: string[]
}) {
  const t = useT()
  const router = useRouter()
  const [values, setValues] = useState<FormValues>(defaults)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [account, setAccount] = useState({ create: false, password: '' })
  const [signedUp, setSignedUp] = useState(false)
  const set = (id: string, v: unknown) => setValues((s) => ({ ...s, [id]: v }))
  const emailField = config.fields.find((f) => f.type === 'email')
  const offerSignup = !!config.allow_signup && !config.login_required && !signedIn && !signedUp && !!emailField

  async function signup(): Promise<boolean> {
    const nameField = config.fields.find((f) => f.column === 'name' && config.targets[f.target]?.table === 'contact')
    const email = String(values[emailField!.id] ?? '')
    const res = await fetch('/api/site-auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: account.password, name: String((nameField && values[nameField.id]) || email) }),
    }).catch(() => null)
    if (res?.ok) {
      setSignedUp(true)
      return true
    }
    if (res?.status === 409) setErrors({ [emailField!.id]: t('This email already has an account — log in instead.') })
    setStatus({ kind: 'error', message: res?.status === 409 ? t('Please check the form.')
      : res?.status === 429 ? t('Too many attempts. Please try again later.')
        : res?.status === 400 ? t('Please check the form.') : t('Something went wrong. Please try again.') })
    return false
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const missing: Record<string, string> = {}
    for (const f of config.fields) if (f.required && isEmpty(f, values[f.id])) missing[f.id] = t('This field is required.')
    const creating = offerSignup && account.create
    if (creating && account.password.length < MIN_PASSWORD) missing.__password = t('Password must be at least 8 characters.')
    setErrors(missing)
    if (Object.keys(missing).length) return setStatus({ kind: 'error', message: t('Please check the form.') })
    setStatus({ kind: 'submitting' })
    if (creating && !(await signup())) return
    const body = { values: Object.fromEntries(config.fields.map((f) => [f.id, wire(f, values[f.id])])) }
    const res = await fetch(`/api/site-forms/${encodeURIComponent(pageId)}/${encodeURIComponent(blockId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null)
    if (creating || signedUp) router.refresh() // the site header picks up the new session
    if (res?.ok) {
      if (config.after.kind === 'page' && config.after.slug) {
        router.push(safeNext(`/${config.after.slug}`, '/'))
        return
      }
      return setStatus({ kind: 'done' })
    }
    const err = (await res?.json().catch(() => null)) as { error?: { fields?: string[] } } | null
    const fields = res?.status === 422 ? err?.error?.fields ?? [] : []
    setErrors(Object.fromEntries(fields.map((id) => [id, t('Check this value.')])))
    setStatus({ kind: 'error', message:
      res?.status === 422 && fields.length ? t('Please check the form.')
        : res?.status === 422 || res?.status === 404 ? t('This form is not available right now.')
          : res?.status === 401 ? t('Please log in to send this form.')
            : res?.status === 429 ? t('Too many attempts. Please try again later.')
              : t('Something went wrong. Please try again.') })
  }

  if (status.kind === 'done') {
    return <ViewBanner status="info">{config.after.message || t('Thank you — your answers were sent.')}</ViewBanner>
  }

  const input = (f: FormField) => {
    const err = errors[f.id]
    const common = { id: `form-${blockId}-${f.id}`, label: f.label, required: f.required, error: !!err, helperText: err, fullWidth: true }
    const str = values[f.id] == null ? '' : String(values[f.id])
    switch (f.type) {
      case 'checkbox':
        return (
          <FormControl key={f.id} error={!!err}>
            <FormControlLabel label={`${f.label}${f.required ? ' *' : ''}`}
              control={<Checkbox checked={values[f.id] === true} onChange={(e) => set(f.id, e.target.checked)} />} />
            {err && <FormHelperText>{err}</FormHelperText>}
          </FormControl>
        )
      case 'select':
        return (
          <TextField key={f.id} {...common} select value={str} onChange={(e) => set(f.id, e.target.value)}>
            {!f.required && <MenuItem value="">{t('None')}</MenuItem>}
            {(f.options ?? []).map((o) => <MenuItem key={o} value={o}>{o}</MenuItem>)}
          </TextField>
        )
      case 'address': {
        const a = (values[f.id] ?? {}) as Record<string, string>
        return (
          <FormControl key={f.id} component="fieldset" error={!!err} required={f.required}>
            <FormLabel component="legend" sx={{ mb: 1 }}>{f.label}</FormLabel>
            <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: 'wrap' }}>
              {ADDRESS_PARTS.map((p) => (
                <TextField key={p.key} id={`form-${blockId}-${f.id}-${p.key}`} size="small" label={t(p.label)}
                  type={p.key === 'number' ? 'number' : 'text'} value={a[p.key] ?? ''}
                  onChange={(e) => set(f.id, { ...a, [p.key]: e.target.value })}
                  sx={{ flex: p.wide ? '1 1 100%' : '1 1 140px' }} />
              ))}
            </Stack>
            {err && <FormHelperText>{err}</FormHelperText>}
          </FormControl>
        )
      }
      default:
        return (
          <TextField key={f.id} {...common} value={str} onChange={(e) => set(f.id, e.target.value)}
            multiline={f.type === 'long'} minRows={f.type === 'long' ? 4 : undefined}
            type={f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
            slotProps={{ htmlInput: { readOnly: locked.includes(f.id) }, inputLabel: f.type === 'date' ? { shrink: true } : undefined }} />
        )
    }
  }

  return (
    <Stack component="form" spacing={2} noValidate onSubmit={(e) => void submit(e)}>
      {status.kind === 'error' && <ViewBanner status="error">{status.message}</ViewBanner>}
      {config.fields.map(input)}
      {offerSignup && (
        <>
          <FormControlLabel label={t('Create an account')}
            control={<Checkbox checked={account.create} onChange={(e) => setAccount((s) => ({ ...s, create: e.target.checked }))} />} />
          {account.create && (
            <TextField id={`form-${blockId}-password`} label={t('Password')} type="password" autoComplete="new-password" required
              value={account.password} onChange={(e) => setAccount((s) => ({ ...s, password: e.target.value }))}
              error={!!errors.__password} helperText={errors.__password ?? t('At least 8 characters.')} />
          )}
        </>
      )}
      <Button type="submit" variant="contained" disabled={!pageId || status.kind === 'submitting'} sx={{ alignSelf: 'flex-start' }}>
        {config.submit_label || t('Send')}
      </Button>
    </Stack>
  )
}
