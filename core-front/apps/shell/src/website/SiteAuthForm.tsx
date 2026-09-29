'use client'
import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { useT } from '@eerp/core-front'
import { safeHref } from './urls'

const MIN_PASSWORD = 8 // Go's website signup rule (8 to 72 characters)

// Same-site relative paths only (safeHref refuses control chars, whitespace and
// backslashes the URL parser would strip into "//evil.example"), never into the ERP.
const safeNext = (n?: string) =>
  n && n.startsWith('/') && safeHref(n) && n.split(/[/?#]/)[1] !== 'app' ? n : '/account'

/** Website visitor login/signup, posting to the /api/site-auth BFF routes (ADR-024). */
export function SiteAuthForm({ mode, next }: { mode: 'login' | 'signup'; next?: string }) {
  const t = useT()
  const router = useRouter()
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (mode === 'signup' && form.password.length < MIN_PASSWORD) {
      return setError(t('Password must be at least 8 characters.'))
    }
    setPending(true)
    const body = mode === 'login'
      ? { email: form.email, password: form.password }
      : { email: form.email, password: form.password, name: form.name }
    const res = await fetch(`/api/site-auth/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null)
    if (!res?.ok) {
      setPending(false)
      // Go's messages are English: map the statuses a visitor can hit to translated text.
      const status = res?.status
      return setError(
        status === 401 ? t('Invalid email or password.')
          : status === 409 ? t('This email cannot be used.')
            : status === 429 ? t('Too many attempts. Please try again later.')
              : status === 400 ? t('Please check the form.')
                : t('Something went wrong. Please try again.'),
      )
    }
    router.push(safeNext(next))
    // The session cookie was just set: re-fetch the server tree so the site header
    // (rendered by the server layout) picks it up.
    router.refresh()
  }

  const login = mode === 'login'
  return (
    <Stack component="form" spacing={2} onSubmit={onSubmit}>
      <Typography variant="h4" component="h1">{login ? t('Log in') : t('Sign up')}</Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {!login && (
        <TextField id="site-name" label={t('Name')} autoComplete="name" value={form.name} onChange={set('name')} required />
      )}
      <TextField id="site-email" label={t('Email')} type="email" autoComplete="email" value={form.email} onChange={set('email')} required />
      <TextField
        id="site-password"
        label={t('Password')}
        type="password"
        autoComplete={login ? 'current-password' : 'new-password'}
        helperText={login ? undefined : t('At least 8 characters.')}
        value={form.password}
        onChange={set('password')}
        required
      />
      <Button type="submit" variant="contained" disabled={pending}>{login ? t('Log in') : t('Sign up')}</Button>
      {login
        ? <Link href="/signup">{t('No account yet? Sign up')}</Link>
        : <Link href="/login">{t('Already have an account? Log in')}</Link>}
    </Stack>
  )
}
